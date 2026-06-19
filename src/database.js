const fs = require("fs");
const path = require("path");

function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const initialState = { nextId: 1, tracks: [] };

  function loadState() {
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, JSON.stringify(initialState, null, 2));
      return structuredClone(initialState);
    }

    try {
      const content = fs.readFileSync(dbPath, "utf8");
      const parsed = JSON.parse(content);
      const state = {
        nextId: Number(parsed.nextId) || 1,
        tracks: Array.isArray(parsed.tracks) ? parsed.tracks : []
      };
      state.tracks = state.tracks.map((track) => ({
        genre: null,
        ...track
      }));
      return state;
    } catch {
      fs.writeFileSync(dbPath, JSON.stringify(initialState, null, 2));
      return structuredClone(initialState);
    }
  }

  function saveState(state) {
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
  }

  let state = loadState();

  function now() {
    return new Date().toISOString();
  }

  return {
    raw: null,

    upsertTrack(track) {
      const existing = state.tracks.find((item) => item.source_path === track.sourcePath);
      if (existing) {
        existing.title = track.title;
        existing.artist = track.artist || null;
        existing.album = track.album || null;
        existing.genre = track.genre || null;
        existing.duration_seconds = track.durationSeconds || null;
        existing.updated_at = now();
        saveState(state);
        return existing.id;
      }

      const record = {
        id: state.nextId++,
        source_type: track.sourceType || "local",
        source_path: track.sourcePath,
        title: track.title,
        artist: track.artist || null,
        album: track.album || null,
        genre: track.genre || null,
        duration_seconds: track.durationSeconds || null,
        cache_path: track.cachePath || null,
        created_at: now(),
        updated_at: now(),
        last_played_at: null
      };

      state.tracks.push(record);
      saveState(state);
      return record.id;
    },

    getTrack(id) {
      return state.tracks.find((track) => track.id === id);
    },

    getTrackBySourcePath(sourcePath) {
      return state.tracks.find((track) => track.source_path === sourcePath);
    },

    listTracks() {
      return [...state.tracks].sort((a, b) =>
        String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
      );
    },

    updateCachePath(id, cachePath) {
      const track = state.tracks.find((item) => item.id === id);
      if (!track) return;
      track.cache_path = cachePath;
      track.updated_at = now();
      saveState(state);
    },

    markPlayed(id) {
      const track = state.tracks.find((item) => item.id === id);
      if (!track) return;
      track.last_played_at = now();
      track.updated_at = now();
      saveState(state);
    }
  };
}

module.exports = { createDatabase };
