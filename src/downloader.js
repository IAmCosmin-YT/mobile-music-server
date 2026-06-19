const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function runYtDlpJson(ytDlpBin, search) {
  return new Promise((resolve, reject) => {
    const args = ["--dump-single-json", "--flat-playlist", search];
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
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp search exited with code ${code}`));
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
  if (candidate.webpage_url) return candidate.webpage_url;
  if (candidate.url && isUrl(candidate.url)) return candidate.url;
  if (candidate.id) return `https://music.youtube.com/watch?v=${candidate.id}`;
  return candidate.url;
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

async function findBestAudioCandidate({ ytDlpBin, query }) {
  if (isUrl(query)) {
    return { url: query, title: query, sourceStrategy: "direct-url", score: 0 };
  }

  const preferredSearches = [
    `ytsearch10:${query} official audio`,
    `ytsearch10:${query} album track`
  ];

  for (const search of preferredSearches) {
    const entries = await runYtDlpJson(ytDlpBin, search);
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

  const fallbackEntries = await runYtDlpJson(ytDlpBin, `ytsearch5:${query}`);
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

function downloadWithYtDlp({ ytDlpBin, query, musicDir }) {
  return new Promise((resolve, reject) => {
    findBestAudioCandidate({ ytDlpBin, query })
      .then((candidate) => {
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
          candidate.url
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
            resolve({ path: downloadedPath, candidate });
          } catch {
            reject(new Error(`Downloaded file not found: ${downloadedPath}`));
          }
        });
      })
      .catch(reject);
  });
}

module.exports = { downloadWithYtDlp, findBestAudioCandidate };
