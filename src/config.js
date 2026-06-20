const path = require("path");
const fs = require("fs");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"));

function boolFromEnv(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function resolveFromCwd(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

const config = {
  port: Number(process.env.PORT || 3000),
  musicDir: resolveFromCwd(process.env.MUSIC_DIR, "./music"),
  cacheDir: resolveFromCwd(process.env.CACHE_DIR, "./cache"),
  dbPath: resolveFromCwd(process.env.DB_PATH, "./music-db.json"),
  enableRemoteFetch: boolFromEnv(process.env.ENABLE_REMOTE_FETCH, false),
  opusBitrate: process.env.OPUS_BITRATE || "64k",
  ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
  ytDlpBin: process.env.YT_DLP_BIN || "yt-dlp",
  ytDlpJsRuntime: process.env.YT_DLP_JS_RUNTIME || "node",
  ytDlpRemoteComponents: process.env.YT_DLP_REMOTE_COMPONENTS || "ejs:github",
  ytDlpExtractorArgs: process.env.YT_DLP_EXTRACTOR_ARGS || "",
  ytDlpImpersonate: process.env.YT_DLP_IMPERSONATE || "",
  ytDlpCookies: process.env.YT_DLP_COOKIES || "",
  ytDlpCookiesFromBrowser: process.env.YT_DLP_COOKIES_FROM_BROWSER || "",
  ytDlpUseOauth2: process.env.YT_DLP_OAUTH2 !== "false",
  ytDlpFormat: process.env.YT_DLP_FORMAT || "bestaudio/best"
};

module.exports = { config };
