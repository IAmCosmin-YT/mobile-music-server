const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

function buildYtDlpBaseArgs(options = {}) {
  const args = [];
  if (options.jsRuntime && options.jsRuntime !== "none") {
    args.push("--js-runtimes", options.jsRuntime);
  }
  if (options.remoteComponents) {
    args.push("--remote-components", options.remoteComponents);
  }
  if (options.extractorArgs) {
    args.push("--extractor-args", options.extractorArgs);
  }
  if (options.impersonate) {
    args.push("--impersonate", options.impersonate);
  }
  if (options.cookies) {
    args.push("--cookies", options.cookies);
  }
  if (options.cookiesFromBrowser) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }
  return args;
}

function buildDownloadPlans(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];

  if (isUrl(trimmed)) {
    return [{
      label: "direct-url",
      target: canonicalYouTubeWatchUrl(trimmed),
      sourceStrategy: "direct-url"
    }];
  }

  return [
    {
      label: "official-audio-search",
      target: `ytsearch1:${trimmed} official audio`,
      sourceStrategy: "official-audio"
    },
    {
      label: "topic-track-search",
      target: `ytsearch1:${trimmed} topic`,
      sourceStrategy: "official-audio"
    },
    {
      label: "album-track-search",
      target: `ytsearch1:${trimmed} album track`,
      sourceStrategy: "album-track"
    },
    {
      label: "audio-track-search",
      target: `ytsearch1:${trimmed} audio`,
      sourceStrategy: "song-audio"
    },
    {
      label: "plain-search-fallback",
      target: `ytsearch1:${trimmed}`,
      sourceStrategy: "fallback-video"
    }
  ];
}

function buildYtDlpDownloadArgs(target, musicDir, options = {}) {
  const template = path.join(musicDir, "%(title).200s.%(ext)s");
  const args = [
    ...buildYtDlpBaseArgs(options),
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
    target
  );

  return args;
}

function runYtDlpDownload(ytDlpBin, plan, musicDir, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildYtDlpDownloadArgs(plan.target, musicDir, options);
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

async function downloadWithYtDlp({
  ytDlpBin,
  query,
  musicDir,
  jsRuntime,
  remoteComponents,
  extractorArgs,
  impersonate,
  cookies,
  cookiesFromBrowser,
  format
}) {
  const plans = buildDownloadPlans(query);
  const errors = [];
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser,
    format
  };

  for (const plan of plans) {
    try {
      const downloadedPath = await runYtDlpDownload(ytDlpBin, plan, musicDir, options);
      return {
        path: downloadedPath,
        candidate: {
          url: plan.target,
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
  cookiesFromBrowser
}) {
  const target = `ytsearch5:${query}`;
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser
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
