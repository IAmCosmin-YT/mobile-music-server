const fs = require("fs");
const path = require("path");

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".wav",
  ".webm",
  ".ogg",
  ".opus"
]);

async function walk(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function titleFromFile(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim();
}

async function readTrackMetadata(filePath) {
  try {
    const mm = await import("music-metadata");
    const metadata = await mm.parseFile(filePath, { duration: true });
    return {
      title: metadata.common.title || titleFromFile(filePath),
      artist: metadata.common.artist || null,
      album: metadata.common.album || null,
      genre: Array.isArray(metadata.common.genre) && metadata.common.genre.length
        ? metadata.common.genre.join(", ")
        : null,
      durationSeconds: metadata.format.duration || null
    };
  } catch {
    return {
      title: titleFromFile(filePath),
      artist: null,
      album: null,
      genre: null,
      durationSeconds: null
    };
  }
}

async function scanLibrary(db, musicDir) {
  await fs.promises.mkdir(musicDir, { recursive: true });
  const files = await walk(musicDir);
  const indexed = [];

  for (const filePath of files) {
    const metadata = await readTrackMetadata(filePath);
    const id = db.upsertTrack({
      sourceType: "local",
      sourcePath: filePath,
      ...metadata
    });
    indexed.push({ id, sourcePath: filePath, ...metadata });
  }

  return indexed;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTrack(track, query) {
  const q = normalize(query);
  if (!q) return 0;
  const haystack = normalize([
    track.title,
    track.artist,
    track.album,
    path.basename(track.source_path || "")
  ].filter(Boolean).join(" "));

  if (haystack === q) return 100;
  if (haystack.includes(q)) return 80 + Math.min(q.length, 20);

  const terms = q.split(" ").filter(Boolean);
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return Math.round((matches / terms.length) * 70);
}

function searchTracks(db, query, limit = 25) {
  return db.listTracks()
    .map((track) => ({ ...track, score: scoreTrack(track, query) }))
    .filter((track) => track.score > 0)
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
}

module.exports = {
  AUDIO_EXTENSIONS,
  scanLibrary,
  searchTracks
};
