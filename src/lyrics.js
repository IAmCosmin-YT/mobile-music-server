const fs = require("fs");
const path = require("path");

function parseTimestamp(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(`0.${match[3].padEnd(3, "0").slice(0, 3)}`) : 0;
  return minutes * 60 + seconds + fraction;
}

function parseLrc(content) {
  const lines = [];
  for (const rawLine of String(content).split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;

    const text = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;

    for (const stamp of stamps) {
      const time = parseTimestamp(stamp[1]);
      if (time !== null) {
        lines.push({ time, text });
      }
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

async function findLyricsForTrack(track) {
  if (!track || !track.source_path) return { synced: false, lines: [] };

  const dir = path.dirname(track.source_path);
  const base = path.basename(track.source_path, path.extname(track.source_path));
  const candidates = [
    path.join(dir, `${base}.lrc`),
    path.join(dir, `${track.artist || ""} - ${track.title || ""}.lrc`)
  ];

  for (const candidate of candidates) {
    try {
      const content = await fs.promises.readFile(candidate, "utf8");
      const lines = parseLrc(content);
      if (lines.length) {
        return { synced: true, path: candidate, lines };
      }
    } catch {
      // Missing lyrics files are expected for many local libraries.
    }
  }

  return { synced: false, lines: [] };
}

module.exports = { parseLrc, findLyricsForTrack };
