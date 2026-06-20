const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { config } = require("./config");

function findChromiumPath() {
  if (config.chromiumPath) {
    return config.chromiumPath;
  }

  const platform = process.platform;
  let paths = [];

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

    paths = [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Chromium", "Application", "chrome.exe")
    ];
  } else {
    // Unix-like, including Android Termux
    paths = [
      "/data/data/com.termux/files/usr/bin/chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chrome"
    ];
  }

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to whatever is in the PATH
  return platform === "win32" ? "chrome.exe" : "chromium";
}

async function extractAudioUrl(youtubeUrl) {
  const executablePath = findChromiumPath();
  console.log(`[Chromium] Launching browser at ${executablePath}...`);

  const userDataDir = path.join(config.cacheDir, "puppeteer_data");
  console.log(`[Chromium] Using user data directory: ${userDataDir}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  try {
    const page = await browser.newPage();

    // Hide WebDriver flag and set plugins/languages to mimic real browser
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // Set a realistic desktop user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setViewport({ width: 1280, height: 720 });

    let capturedUrl = null;
    let poToken = null;
    let visitorData = null;

    // Passive request interceptor
    page.on("request", (req) => {
      const url = req.url();
      
      // Capture videoplayback URL
      if (url.includes("videoplayback") && (url.includes("mime=audio") || url.includes("mime%3Daudio"))) {
        capturedUrl = url;
      }

      // Capture PO Token and Visitor Data from youtubei/v1/player POST payload
      if (url.includes("youtubei/v1/player")) {
        try {
          const postDataStr = req.postData();
          if (postDataStr) {
            const data = JSON.parse(postDataStr);
            if (data.serviceIntegrityDimensions && data.serviceIntegrityDimensions.poToken) {
              poToken = data.serviceIntegrityDimensions.poToken;
              console.log("[Chromium] Extracted PO Token:", poToken);
            }
            if (data.context && data.context.client && data.context.client.visitorData) {
              visitorData = data.context.client.visitorData;
              console.log("[Chromium] Extracted Visitor Data:", visitorData);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    });

    console.log(`[Chromium] Navigating to watch URL: ${youtubeUrl}`);
    await page.goto(youtubeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[Chromium] Page loaded. Waiting for audio playback stream or tokens...`);

    let clickedConsent = false;
    const startTime = Date.now();
    
    // Poll until we get BOTH the capturedUrl AND the tokens, up to 25 seconds
    // If we have the tokens, wait at least 8 seconds to try and also get the stream URL fallback.
    while (Date.now() - startTime < 25000) {
      if (capturedUrl && poToken && visitorData) {
        break;
      }
      if (poToken && visitorData && (Date.now() - startTime > 8000)) {
        break;
      }

      // Handle consent dialog
      if (!clickedConsent) {
        try {
          const consentButton = await page.$("form[action*='consent.google'] button, button[aria-label*='Accept the use of cookies'], button[aria-label*='Accept all'], button[aria-label*='I agree']");
          if (consentButton) {
            console.log("[Chromium] Clicking consent/cookie dialog...");
            clickedConsent = true;
            await consentButton.click();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
        } catch (e) {
          // ignore
        }
      }

      // Try triggering play
      try {
        await page.evaluate(() => {
          const video = document.querySelector("video");
          if (video) {
            video.play().catch(() => {});
          }
        });
      } catch (e) {
        // ignore
      }

      try {
        const videoElement = await page.$("video");
        if (videoElement) {
          await videoElement.click();
        }
      } catch (e) {
        // ignore
      }

      try {
        const playButton = await page.$(".ytp-large-play-button, button.ytp-play-button");
        if (playButton) {
          const isDisplayed = await page.evaluate((el) => {
            return el && el.style.display !== "none" && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, playButton);
          if (isDisplayed) {
            console.log("[Chromium] Clicking play button...");
            await playButton.click();
          }
        }
      } catch (e) {
        // ignore
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!capturedUrl && !poToken) {
      const debugScreenshotPath = path.join(config.cacheDir, "chromium-timeout.png");
      try {
        fs.mkdirSync(config.cacheDir, { recursive: true });
        await page.screenshot({ path: debugScreenshotPath });
        console.log(`[Chromium] Saved debug screenshot to: ${debugScreenshotPath}`);
      } catch (screenshotError) {
        console.error("[Chromium] Failed to take timeout screenshot:", screenshotError.message);
      }
      throw new Error("Timeout: Could not intercept videoplayback URL or PO Token.");
    }

    let title = "audio-track";
    try {
      const pageTitle = await page.title();
      if (pageTitle) {
        title = pageTitle.replace(/ - YouTube$/, "").trim();
      }
    } catch (e) {
      console.warn("[Chromium] Failed to extract page title:", e.message);
    }

    let cleanUrl = null;
    if (capturedUrl) {
      const parsedUrl = new URL(capturedUrl);
      parsedUrl.searchParams.delete("range");
      parsedUrl.searchParams.delete("index");
      cleanUrl = parsedUrl.toString();
    }

    const cookies = await page.cookies();
    return {
      url: cleanUrl,
      title,
      poToken,
      visitorData,
      cookies
    };
  } finally {
    await browser.close();
    console.log("[Chromium] Browser closed.");
  }
}

function downloadAudioStream(url, baseName, musicDir) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive"
      }
    };

    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download audio stream: HTTP ${res.statusCode}`));
        return;
      }

      const contentType = res.headers["content-type"] || "";
      let ext = ".webm";
      if (contentType.includes("audio/mp4") || contentType.includes("video/mp4") || contentType.includes("audio/aac")) {
        ext = ".m4a";
      } else if (contentType.includes("audio/mpeg")) {
        ext = ".mp3";
      } else if (contentType.includes("audio/ogg") || contentType.includes("audio/opus")) {
        ext = ".ogg";
      }

      const safeBaseName = baseName.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100).trim() || "downloaded-audio";
      const destPath = path.join(musicDir, `${safeBaseName}${ext}`);

      console.log(`[Chromium] Downloading to: ${destPath}`);
      const file = fs.createWriteStream(destPath);
      res.pipe(file);

      file.on("finish", () => {
        file.close(() => resolve(destPath));
      });

      file.on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on("error", reject);
  });
}

module.exports = {
  extractAudioUrl,
  downloadAudioStream
};
