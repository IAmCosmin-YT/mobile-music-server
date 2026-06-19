const express = require("express");
const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const { createDatabase } = require("./database");
const { scanLibrary, searchTracks } = require("./library");
const { ensureOpusCache } = require("./transcode");
const { downloadWithYtDlp } = require("./downloader");
const { findLyricsForTrack } = require("./lyrics");
const { similarTracks } = require("./recommendations");

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
    genre: track.genre,
    durationSeconds: track.duration_seconds,
    hasCache: Boolean(track.cache_path),
    streamUrl: `/stream?id=${encodeURIComponent(track.id)}`,
    lyricsUrl: `/lyrics?id=${encodeURIComponent(track.id)}`,
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
  const downloaded = await downloadWithYtDlp({
    ytDlpBin: config.ytDlpBin,
    jsRuntime: config.ytDlpJsRuntime,
    remoteComponents: config.ytDlpRemoteComponents,
    extractorArgs: config.ytDlpExtractorArgs,
    impersonate: config.ytDlpImpersonate,
    cookies: config.ytDlpCookies,
    cookiesFromBrowser: config.ytDlpCookiesFromBrowser,
    format: config.ytDlpFormat,
    query,
    musicDir: config.musicDir
  });
  const downloadedPath = downloaded.path;

  await scanLibrary(db, config.musicDir);
  const track = db.getTrackBySourcePath(downloadedPath) || searchTracks(db, query, 1)[0] || null;
  if (track) {
    track.sourceStrategy = downloaded.candidate.sourceStrategy;
  }
  return track;
}

function parseExcludeIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter(Number.isInteger);
}

async function sendAudioFile(req, res, filePath) {
  const stat = await fs.promises.stat(filePath);
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "audio/ogg; codecs=opus");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filePath)}"`);

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.status(416).end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    return;
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    port: config.port,
    musicDir: config.musicDir,
    cacheDir: config.cacheDir,
    dbPath: config.dbPath,
    remoteFetchEnabled: config.enableRemoteFetch,
    ytDlpJsRuntime: config.ytDlpJsRuntime,
    ytDlpRemoteComponents: config.ytDlpRemoteComponents || null,
    ytDlpExtractorArgs: config.ytDlpExtractorArgs || null,
    ytDlpImpersonate: config.ytDlpImpersonate || null,
    ytDlpCookiesConfigured: Boolean(config.ytDlpCookies),
    ytDlpCookiesFromBrowser: config.ytDlpCookiesFromBrowser || null,
    ytDlpFormat: config.ytDlpFormat || null,
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

app.get("/library", asyncRoute(async (req, res) => {
  const query = String(req.query.q || "").trim();
  const tracks = query ? searchTracks(db, query, 100) : db.listTracks();
  res.json({
    ok: true,
    count: tracks.length,
    tracks: tracks.map(serializeTrack)
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

app.get("/resolve", asyncRoute(async (req, res) => {
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

  res.json({ ok: true, track: serializeTrack(track), sourceStrategy: track.sourceStrategy || "local" });
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
  await sendAudioFile(req, res, cachePath);
}));

app.get("/lyrics", asyncRoute(async (req, res) => {
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

  const lyrics = await findLyricsForTrack(track);
  res.json({ ok: true, track: serializeTrack(track), ...lyrics });
}));

app.get("/queue/similar", asyncRoute(async (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ ok: false, error: "Missing or invalid required query parameter: id" });
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 25);
  const tracks = similarTracks(db, id, {
    excludeIds: parseExcludeIds(req.query.exclude),
    limit
  });

  res.json({ ok: true, tracks: tracks.map(serializeTrack) });
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
