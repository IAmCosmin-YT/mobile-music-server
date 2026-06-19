const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function wrapYtDlpSpawnError(error) {
  if (error && error.code === "ENOENT") {
    return new Error(
      "yt-dlp is not installed or is not on PATH. In Termux, run: python -m pip install -U yt-dlp"
    );
  }
  return error;
}

function friendlyYtDlpExitError(stderr, code) {
  const output = String(stderr || "").trim();
  const tail = output.split(/\r?\n/).slice(-8).join("\n");
  if (output.includes("No supported JavaScript runtime") || output.includes("HTTP Error 403")) {
    return new Error(
      [
        "YouTube rejected the yt-dlp request.",
        "The app is already passing --js-runtimes node and audio-first format options.",
        "Try updating yt-dlp/EJS or set YT_DLP_REMOTE_COMPONENTS=ejs:github.",
        tail ? `yt-dlp output:\n${tail}` : ""
      ].filter(Boolean).join("\n")
    );
  }
  return new Error(output || `yt-dlp exited with code ${code}`);
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
  return args;
}

function buildYtDlpSearchArgs(search, options = {}) {
  return [
    ...buildYtDlpBaseArgs(options),
    "--dump-single-json",
    "--flat-playlist",
    search
  ];
}

function buildYtDlpDownloadArgs(candidate, musicDir, options = {}) {
  const template = path.join(musicDir, "%(title).200s.%(ext)s");
  return [
    ...buildYtDlpBaseArgs(options),
    "--format",
    options.format || "bestaudio[ext=m4a]/bestaudio/best",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--print",
    "after_move:filepath",
    "-o",
    template,
    candidate.url
  ];
}

function runYtDlpJson(ytDlpBin, search, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildYtDlpSearchArgs(search, options);
    const child = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(wrapYtDlpSpawnError(error)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(friendlyYtDlpExitError(stderr, code));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed.entries) ? parsed.entries.filter(Boolean) : [parsed]);
      } catch (error) {
        reject(new Error(`Unable to parse yt-dlp search results: ${error.message}`));
      }
    });
  });
}

function candidateUrl(candidate) {
  if (candidate.webpage_url) return canonicalYouTubeWatchUrl(candidate.webpage_url);
  if (candidate.url && isUrl(candidate.url)) return canonicalYouTubeWatchUrl(candidate.url);
  if (candidate.id) return `https://www.youtube.com/watch?v=${candidate.id}`;
  return candidate.url;
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

function scoreCandidate(candidate, query) {
  const title = String(candidate.title || "").toLowerCase();
  const uploader = String(candidate.uploader || candidate.channel || "").toLowerCase();
  const text = `${title} ${uploader}`;
  let score = 0;

  if (text.includes("official audio")) score += 120;
  if (uploader.includes("topic")) score += 90;
  if (text.includes("provided to youtube")) score += 70;
  if (text.includes("album")) score += 35;
  if (title.includes("audio")) score += 30;
  if (normalizeForScore(title).includes(normalizeForScore(query))) score += 25;

  if (text.includes("official video")) score -= 80;
  if (text.includes("music video")) score -= 80;
  if (text.includes("trailer")) score -= 90;
  if (text.includes("interview")) score -= 90;
  if (text.includes("reaction")) score -= 90;
  if (text.includes("live")) score -= 45;
  if (text.includes("shorts")) score -= 40;
  if (candidate.duration && candidate.duration > 720) score -= 40;

  return score;
}

function normalizeForScore(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findBestAudioCandidate({ ytDlpBin, query, jsRuntime, remoteComponents, extractorArgs }) {
  if (isUrl(query)) {
    return { url: canonicalYouTubeWatchUrl(query), title: query, sourceStrategy: "direct-url", score: 0 };
  }

  const ytDlpOptions = { jsRuntime, remoteComponents, extractorArgs };

  const preferredSearches = [
    `ytsearch10:${query} official audio`,
    `ytsearch10:${query} album track`
  ];

  for (const search of preferredSearches) {
    const entries = await runYtDlpJson(ytDlpBin, search, ytDlpOptions);
    const best = entries
      .map((entry) => ({ ...entry, score: scoreCandidate(entry, query) }))
      .sort((a, b) => b.score - a.score)[0];

    if (best && best.score >= 50) {
      return {
        ...best,
        url: candidateUrl(best),
        sourceStrategy: "official-audio"
      };
    }
  }

  const fallbackEntries = await runYtDlpJson(ytDlpBin, `ytsearch5:${query}`, ytDlpOptions);
  const fallback = fallbackEntries
    .map((entry) => ({ ...entry, score: scoreCandidate(entry, query) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!fallback) {
    throw new Error("No YouTube result found for that query");
  }

  return {
    ...fallback,
    url: candidateUrl(fallback),
    sourceStrategy: "fallback-video"
  };
}

function downloadWithYtDlp({ ytDlpBin, query, musicDir, jsRuntime, remoteComponents, extractorArgs, format }) {
  return new Promise((resolve, reject) => {
    findBestAudioCandidate({ ytDlpBin, query, jsRuntime, remoteComponents, extractorArgs })
      .then((candidate) => {
        const args = buildYtDlpDownloadArgs(candidate, musicDir, {
          jsRuntime,
          remoteComponents,
          extractorArgs,
          format
        });

        const child = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => reject(wrapYtDlpSpawnError(error)));
        child.on("close", async (code) => {
          if (code !== 0) {
            reject(friendlyYtDlpExitError(stderr, code));
            return;
          }

          const downloadedPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
          if (!downloadedPath) {
            reject(new Error("yt-dlp did not report a downloaded file path"));
            return;
          }

          try {
            await fs.promises.access(downloadedPath, fs.constants.R_OK);
            resolve({ path: downloadedPath, candidate });
          } catch {
            reject(new Error(`Downloaded file not found: ${downloadedPath}`));
          }
        });
      })
      .catch(reject);
  });
}

module.exports = {
  downloadWithYtDlp,
  findBestAudioCandidate,
  buildYtDlpBaseArgs,
  buildYtDlpSearchArgs,
  buildYtDlpDownloadArgs
};
