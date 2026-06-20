const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { extractAudioUrl, downloadAudioStream } = require("./chromiumDownloader");

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function canonicalYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "music.youtube.com" && parsed.searchParams.has("v")) {
      return `https://www.youtube.com/watch?v=${parsed.searchParams.get("v")}`;
    }
    if (parsed.hostname === "youtu.be" && parsed.pathname.length > 1) {
      return `https://www.youtube.com/watch?v=${parsed.pathname.slice(1)}`;
    }
    return url;
  } catch {
    return url;
  }
}

function wrapSpawnError(error) {
  if (error && error.code === "ENOENT") {
    return new Error(
      "yt-dlp is not installed or is not on PATH. In Termux, run: python -m pip install -U \"yt-dlp[default]\""
    );
  }
  return error;
}

function tail(text, lines = 10) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

function makeExitError(stderr, code, label, target) {
  return new Error([
    `yt-dlp failed during ${label}.`,
    `Target: ${target}`,
    tail(stderr) || `yt-dlp exited with code ${code}`
  ].join("\n"));
}

function combineAttemptErrors(errors) {
  return new Error([
    "yt-dlp could not download a playable audio file after trying the rebuilt downloader pipeline.",
    ...errors.map((error, index) => `Attempt ${index + 1} (${error.label}):\n${error.message}`)
  ].join("\n\n"));
}

function buildYtDlpBaseArgs(options = {}, plan = {}) {
  const args = [];
  if (options.jsRuntime && options.jsRuntime !== "none") {
    args.push("--js-runtimes", options.jsRuntime);
  }
  if (options.remoteComponents) {
    args.push("--remote-components", options.remoteComponents);
  }
  if (options.userAgent) {
    args.push("--user-agent", options.userAgent);
  }
  if (options.extractorArgs) {
    args.push("--extractor-args", options.extractorArgs);
  }
  if (options.impersonate) {
    args.push("--impersonate", options.impersonate);
  }
  if (options.cookies && !plan.noCookies) {
    args.push("--cookies", options.cookies);
  }
  if (options.cookiesFromBrowser && !plan.noCookies) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }
  if (options.useOauth2 && !plan.noCookies) {
    args.push("--username", "oauth2", "--password", "");
  }
  return args;
}

function buildDownloadPlans(query, url) {
  const plans = [];
  const trimmedUrl = String(url || "").trim();
  const trimmedQuery = String(query || "").trim();

  if (trimmedUrl && isUrl(trimmedUrl)) {
    if (trimmedUrl.includes("youtube.com") || trimmedUrl.includes("youtu.be")) {
      plans.push({
        label: "chromium-interception",
        target: canonicalYouTubeWatchUrl(trimmedUrl),
        sourceStrategy: "direct-url",
        useChromium: true
      });
    }
    plans.push({
      label: "direct-url",
      target: canonicalYouTubeWatchUrl(trimmedUrl),
      sourceStrategy: "direct-url"
    });
    plans.push({
      label: "direct-url-no-cookies",
      target: canonicalYouTubeWatchUrl(trimmedUrl),
      sourceStrategy: "direct-url",
      noCookies: true
    });
  }

  if (trimmedQuery && !isUrl(trimmedQuery)) {
    plans.push(
      {
        label: "chromium-search-fallback",
        target: `ytsearch1:${trimmedQuery} official audio`,
        sourceStrategy: "official-audio",
        useChromium: true
      },
      {
        label: "topic-track-search-no-cookies",
        target: `ytsearch1:${trimmedQuery} topic`,
        sourceStrategy: "official-audio",
        noCookies: true
      },
      {
        label: "official-audio-search",
        target: `ytsearch1:${trimmedQuery} official audio`,
        sourceStrategy: "official-audio"
      },
      {
        label: "topic-track-search",
        target: `ytsearch1:${trimmedQuery} topic`,
        sourceStrategy: "official-audio"
      },
      {
        label: "ytmusic-search-no-cookies",
        target: `ytmsearch1:${trimmedQuery}`,
        sourceStrategy: "ytmusic",
        noCookies: true
      },
      {
        label: "album-track-search",
        target: `ytsearch1:${trimmedQuery} album track`,
        sourceStrategy: "album-track"
      },
      {
        label: "audio-track-search",
        target: `ytsearch1:${trimmedQuery} audio`,
        sourceStrategy: "song-audio"
      },
      {
        label: "plain-search-fallback",
        target: `ytsearch1:${trimmedQuery}`,
        sourceStrategy: "fallback-video"
      },
      {
        label: "soundcloud-search",
        target: `scsearch1:${trimmedQuery}`,
        sourceStrategy: "soundcloud"
      }
    );
  }

  return plans;
}

function buildYtDlpDownloadArgs(plan, musicDir, options = {}) {
  const template = path.join(musicDir, "%(title).200s.%(ext)s");
  const args = [
    ...buildYtDlpBaseArgs(options, plan),
    "--force-overwrites",
    "--no-continue",
    "--retries",
    "3",
    "--fragment-retries",
    "3"
  ];

  if (options.format) {
    args.push("--format", options.format);
  }

  args.push(
    "--no-playlist",
    "--print",
    "after_move:filepath",
    "-o",
    template,
    plan.target
  );

  return args;
}

function runYtDlpDownload(ytDlpBin, plan, musicDir, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildYtDlpDownloadArgs(plan, musicDir, options);
    const child = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(wrapSpawnError(error)));
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(makeExitError(stderr, code, plan.label, plan.target));
        return;
      }

      const downloadedPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!downloadedPath) {
        reject(new Error(`yt-dlp did not report a downloaded file path for ${plan.target}`));
        return;
      }

      try {
        const stat = await fs.promises.stat(downloadedPath);
        if (!stat.isFile() || stat.size === 0) {
          reject(new Error(`Downloaded file is empty: ${downloadedPath}`));
          return;
        }
        resolve(downloadedPath);
      } catch {
        reject(new Error(`Downloaded file not found: ${downloadedPath}`));
      }
    });
  });
}

function saveCookiesToNetscapeFile(cookies, filePath) {
  let content = "# Netscape HTTP Cookie File\n# This file was generated by Mobile Music Server.\n\n";
  for (const cookie of cookies) {
    const domain = cookie.domain;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = cookie.path;
    const secure = cookie.secure ? "TRUE" : "FALSE";
    let expires = cookie.expires ? Math.round(cookie.expires) : 0;
    if (expires < 0) {
      expires = 0;
    }
    const name = cookie.name;
    const value = cookie.value;
    content += `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expires}\t${name}\t${value}\n`;
  }
  fs.writeFileSync(filePath, content, "utf8");
}

async function runChromiumDownload(plan, musicDir, query, options, ytDlpBin) {
  let targetUrl = plan.target;

  if (!isUrl(targetUrl)) {
    console.log(`[Chromium] Target is search query: "${targetUrl}". Resolving top search result first...`);
    const cleanQuery = targetUrl.replace(/^(yt|ytm|sc)search\d+:/i, "");
    try {
      const searchResults = await searchRemoteWithYtDlp({
        ytDlpBin,
        query: cleanQuery,
        jsRuntime: options.jsRuntime,
        remoteComponents: options.remoteComponents,
        extractorArgs: options.extractorArgs,
        impersonate: options.impersonate,
        cookies: options.cookies,
        cookiesFromBrowser: options.cookiesFromBrowser,
        useOauth2: options.useOauth2
      });

      if (searchResults && searchResults.length > 0) {
        targetUrl = searchResults[0].url;
        console.log(`[Chromium] Resolved top search result to: ${targetUrl}`);
      } else {
        throw new Error(`No search results found for query: ${cleanQuery}`);
      }
    } catch (searchError) {
      throw new Error(`Failed to resolve search query via yt-dlp: ${searchError.message}`);
    }
  }

  let tempCookiesPath = null;
  try {
    const { url, title, poToken, visitorData, cookies } = await extractAudioUrl(targetUrl);

    // Save cookies to temporary file if they exist
    if (cookies && cookies.length > 0) {
      const { config } = require("./config");
      fs.mkdirSync(config.cacheDir, { recursive: true });
      tempCookiesPath = path.join(config.cacheDir, `temp_cookies_${Date.now()}.txt`);
      saveCookiesToNetscapeFile(cookies, tempCookiesPath);
    }

    // Try running yt-dlp with the extracted PO Token first!
    if (poToken) {
      console.log("[Chromium] Trying download via yt-dlp using extracted PO Token...");
      try {
        let tokenArgs = `youtube:player_client=web;po_token=web+${poToken}`;
        if (visitorData) {
          let decodedVisitorData = visitorData;
          try {
            decodedVisitorData = decodeURIComponent(visitorData);
          } catch (e) {
            // ignore
          }
          tokenArgs += `;visitor_data=${decodedVisitorData}`;
        }

        const mergedExtractorArgs = options.extractorArgs
          ? `${options.extractorArgs};${tokenArgs}`
          : tokenArgs;

        const ytDlpOptions = {
          ...options,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          cookies: tempCookiesPath || options.cookies,
          extractorArgs: mergedExtractorArgs
        };

        const tempPlan = {
          ...plan,
          target: targetUrl,
          label: `${plan.label}-with-potoken`
        };

        const downloadedPath = await runYtDlpDownload(ytDlpBin, tempPlan, musicDir, ytDlpOptions);
        console.log("[Chromium] Successful download via yt-dlp using PO Token!");
        return { path: downloadedPath, resolvedUrl: targetUrl };
      } catch (ytDlpError) {
        console.warn("[Chromium] yt-dlp download with PO Token failed, falling back to direct stream download. Error:", ytDlpError.message);
      }
    }

    // Fallback: download direct stream URL using https.get
    if (url) {
      console.log("[Chromium] Running direct stream URL download fallback...");
      const name = title || query || "downloaded-audio";
      const downloadedPath = await downloadAudioStream(url, name, musicDir);
      return { path: downloadedPath, resolvedUrl: targetUrl };
    }

    throw new Error("Could not download stream: neither PO Token nor direct stream URL was captured.");
  } catch (error) {
    throw new Error(`Chromium download failed: ${error.message}`);
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try {
        fs.unlinkSync(tempCookiesPath);
      } catch (unlinkError) {
        console.warn("[Chromium] Failed to delete temporary cookies file:", unlinkError.message);
      }
    }
  }
}

async function downloadWithYtDlp({
  ytDlpBin,
  query,
  url,
  musicDir,
  jsRuntime,
  remoteComponents,
  extractorArgs,
  impersonate,
  cookies,
  cookiesFromBrowser,
  useOauth2,
  format
}) {
  const plans = buildDownloadPlans(query, url);
  const errors = [];
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser,
    useOauth2,
    format
  };

  for (const plan of plans) {
    try {
      let downloadedPath;
      let resolvedUrl = plan.target;
      if (plan.useChromium) {
        const res = await runChromiumDownload(plan, musicDir, query, options, ytDlpBin);
        downloadedPath = res.path;
        resolvedUrl = res.resolvedUrl;
      } else {
        downloadedPath = await runYtDlpDownload(ytDlpBin, plan, musicDir, options);
      }
      return {
        path: downloadedPath,
        candidate: {
          url: resolvedUrl,
          title: query,
          sourceStrategy: plan.sourceStrategy,
          downloadStrategy: plan.label
        }
      };
    } catch (error) {
      errors.push({ label: plan.label, message: error.message });
    }
  }

  throw combineAttemptErrors(errors);
}

function runYtDlpSearch(ytDlpBin, target, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...buildYtDlpBaseArgs(options),
      "-j",
      "--flat-playlist",
      target
    ];

    const child = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(wrapSpawnError(error)));
    child.on("close", (code) => {
      if (code !== 0 && stdout.trim() === "") {
        reject(makeExitError(stderr, code, "search", target));
        return;
      }

      const results = [];
      const lines = stdout.trim().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        try {
          results.push(JSON.parse(line));
        } catch {
          // ignore
        }
      }
      resolve(results);
    });
  });
}

async function searchRemoteWithYtDlp({
  ytDlpBin,
  query,
  jsRuntime,
  remoteComponents,
  extractorArgs,
  impersonate,
  cookies,
  cookiesFromBrowser,
  useOauth2
}) {
  const target = `ytsearch5:${query}`;
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser,
    useOauth2
  };

  const results = await runYtDlpSearch(ytDlpBin, target, options);
  return results.map(r => ({
    id: r.id,
    title: r.title,
    channel: r.uploader || r.channel,
    duration: r.duration,
    thumbnail: r.thumbnails && r.thumbnails.length ? r.thumbnails[r.thumbnails.length - 1].url : r.thumbnail,
    url: r.url || (r.id ? `https://www.youtube.com/watch?v=${r.id}` : null)
  })).filter(r => r.url);
}

async function findBestAudioCandidate({ query }) {
  const [plan] = buildDownloadPlans(query);
  if (!plan) throw new Error("No query provided");
  return {
    url: plan.target,
    title: query,
    sourceStrategy: plan.sourceStrategy,
    score: plan.sourceStrategy === "official-audio" ? 100 : 0
  };
}

module.exports = {
  downloadWithYtDlp,
  searchRemoteWithYtDlp,
  findBestAudioCandidate,
  buildYtDlpBaseArgs,
  buildYtDlpDownloadArgs,
  buildDownloadPlans
};
