const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function hashTrack(track) {
  return crypto
    .createHash("sha1")
    .update(`${track.id}:${track.source_path}`)
    .digest("hex")
    .slice(0, 16);
}

function cachePathForTrack(track, cacheDir) {
  const safeTitle = String(track.title || `track-${track.id}`)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `track-${track.id}`;
  return path.join(cacheDir, `${track.id}-${safeTitle}-${hashTrack(track)}.opus`);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function runFfmpeg({ ffmpegBin, inputPath, outputPath, bitrate }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      bitrate,
      "-application",
      "audio",
      outputPath
    ];

    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

async function ensureOpusCache(track, db, config) {
  if (track.cache_path && await fileExists(track.cache_path)) {
    return track.cache_path;
  }

  await fs.promises.mkdir(config.cacheDir, { recursive: true });
  const outputPath = cachePathForTrack(track, config.cacheDir);
  const tempPath = `${outputPath}.tmp`;

  await runFfmpeg({
    ffmpegBin: config.ffmpegBin,
    inputPath: track.source_path,
    outputPath: tempPath,
    bitrate: config.opusBitrate
  });

  await fs.promises.rename(tempPath, outputPath);
  db.updateCachePath(track.id, outputPath);
  return outputPath;
}

module.exports = { ensureOpusCache };
