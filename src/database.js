const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK (source_type IN ('local', 'remote')),
      source_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration_seconds REAL,
      cache_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_played_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
  `);

  const touchUpdatedAt = db.prepare(`
    UPDATE tracks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);

  return {
    raw: db,

    upsertTrack(track) {
      const result = db.prepare(`
        INSERT INTO tracks (
          source_type, source_path, title, artist, album, duration_seconds, cache_path
        ) VALUES (
          @sourceType, @sourcePath, @title, @artist, @album, @durationSeconds, @cachePath
        )
        ON CONFLICT(source_path) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          duration_seconds = excluded.duration_seconds,
          updated_at = CURRENT_TIMESTAMP
      `).run({
        sourceType: track.sourceType || "local",
        sourcePath: track.sourcePath,
        title: track.title,
        artist: track.artist || null,
        album: track.album || null,
        durationSeconds: track.durationSeconds || null,
        cachePath: track.cachePath || null
      });

      if (result.lastInsertRowid) return Number(result.lastInsertRowid);
      return db.prepare("SELECT id FROM tracks WHERE source_path = ?").get(track.sourcePath).id;
    },

    getTrack(id) {
      return db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
    },

    getTrackBySourcePath(sourcePath) {
      return db.prepare("SELECT * FROM tracks WHERE source_path = ?").get(sourcePath);
    },

    listTracks() {
      return db.prepare("SELECT * FROM tracks ORDER BY title COLLATE NOCASE").all();
    },

    updateCachePath(id, cachePath) {
      db.prepare(`
        UPDATE tracks
        SET cache_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cachePath, id);
    },

    markPlayed(id) {
      db.prepare(`
        UPDATE tracks SET last_played_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(id);
      touchUpdatedAt.run(id);
    }
  };
}

module.exports = { createDatabase };
