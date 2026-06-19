const express = require("express");
const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const { createDatabase } = require("./database");
const { scanLibrary, searchTracks } = require("./library");
const { ensureOpusCache } = require("./transcode");
const { downloadWithYtDlp } = require("./downloader");

const app = express();
const db = createDatabase(config.dbPath);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function serializeTrack(track) {
  return {
    id: track.id,
    sourceType: track.source_type,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSeconds: track.duration_seconds,
    hasCache: Boolean(track.cache_path),
    score: track.score
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function findOrFetch(query) {
  const localMatches = searchTracks(db, query, 1);
  if (localMatches.length > 0) return localMatches[0];

  if (!config.enableRemoteFetch) return null;

  await fs.promises.mkdir(config.musicDir, { recursive: true });
  const downloadedPath = await downloadWithYtDlp({
    ytDlpBin: config.ytDlpBin,
    query,
    musicDir: config.musicDir
  });

  await scanLibrary(db, config.musicDir);
  return db.getTrackBySourcePath(downloadedPath) || searchTracks(db, query, 1)[0] || null;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    port: config.port,
    musicDir: config.musicDir,
    cacheDir: config.cacheDir,
    dbPath: config.dbPath,
    remoteFetchEnabled: config.enableRemoteFetch,
    opusBitrate: config.opusBitrate
  });
});

app.get("/scan", asyncRoute(async (req, res) => {
  const indexed = await scanLibrary(db, config.musicDir);
  res.json({
    ok: true,
    count: indexed.length,
    tracks: indexed.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: track.durationSeconds
    }))
  });
}));

app.get("/search", asyncRoute(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    res.status(400).json({ ok: false, error: "Missing required query parameter: q" });
    return;
  }

  const tracks = searchTracks(db, query);
  res.json({
    ok: true,
    query,
    remoteFetchAvailable: config.enableRemoteFetch,
    tracks: tracks.map(serializeTrack)
  });
}));

app.get("/stream", asyncRoute(async (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ ok: false, error: "Missing or invalid required query parameter: id" });
    return;
  }

  const track = db.getTrack(id);
  if (!track) {
    res.status(404).json({ ok: false, error: "Track not found" });
    return;
  }

  if (track.source_type !== "local") {
    res.status(501).json({ ok: false, error: "Only local source tracks are streamable in this build" });
    return;
  }

  const cachePath = await ensureOpusCache(track, db, config);
  db.markPlayed(track.id);

  res.setHeader("Content-Type", "audio/ogg; codecs=opus");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(cachePath)}"`);
  fs.createReadStream(cachePath).pipe(res);
}));

app.get("/search-and-play", asyncRoute(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    res.status(400).json({ ok: false, error: "Missing required query parameter: q" });
    return;
  }

  const track = await findOrFetch(query);
  if (!track) {
    res.status(404).json({
      ok: false,
      error: config.enableRemoteFetch
        ? "No playable result found"
        : "No local match found. Set ENABLE_REMOTE_FETCH=true to allow yt-dlp fallback."
    });
    return;
  }

  res.redirect(302, `/stream?id=${encodeURIComponent(track.id)}`);
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({
    ok: false,
    error: err.message || "Unexpected server error"
  });
});

if (require.main === module) {
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`Mobile Music Server listening on http://0.0.0.0:${config.port}`);
    console.log(`Music directory: ${config.musicDir}`);
    console.log(`Cache directory: ${config.cacheDir}`);
  });
}

module.exports = { app, db, config };
