const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function downloadWithYtDlp({ ytDlpBin, query, musicDir }) {
  return new Promise((resolve, reject) => {
    const template = path.join(musicDir, "%(title).200s.%(ext)s");
    const args = [
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--no-playlist",
      "--print",
      "after_move:filepath",
      "-o",
      template,
      `ytsearch1:${query}`
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

    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      const downloadedPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!downloadedPath) {
        reject(new Error("yt-dlp did not report a downloaded file path"));
        return;
      }

      try {
        await fs.promises.access(downloadedPath, fs.constants.R_OK);
        resolve(downloadedPath);
      } catch {
        reject(new Error(`Downloaded file not found: ${downloadedPath}`));
      }
    });
  });
}

module.exports = { downloadWithYtDlp };
