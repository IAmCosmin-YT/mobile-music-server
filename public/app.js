const audio = document.querySelector("#audio");
const views = [...document.querySelectorAll(".view")];
const navItems = [...document.querySelectorAll(".nav-item")];
const playerPanels = [...document.querySelectorAll(".player-panel")];
const playerTabs = [...document.querySelectorAll(".tab-button")];

const els = {
  homeStatus: document.querySelector("#homeStatus"),
  quickPicks: document.querySelector("#quickPicks"),
  keepListening: document.querySelector("#keepListening"),
  refreshButton: document.querySelector("#refreshButton"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  searchMessage: document.querySelector("#searchMessage"),
  resolveButton: document.querySelector("#resolveButton"),
  searchResults: document.querySelector("#searchResults"),
  remoteSearchResultsWrapper: document.querySelector("#remoteSearchResultsWrapper"),
  remoteSearchResults: document.querySelector("#remoteSearchResults"),
  libraryFilter: document.querySelector("#libraryFilter"),
  libraryInput: document.querySelector("#libraryInput"),
  libraryTracks: document.querySelector("#libraryTracks"),
  miniPlayer: document.querySelector("#miniPlayer"),
  openPlayerButton: document.querySelector("#openPlayerButton"),
  miniCover: document.querySelector("#miniCover"),
  miniTitle: document.querySelector("#miniTitle"),
  miniArtist: document.querySelector("#miniArtist"),
  miniPlayButton: document.querySelector("#miniPlayButton"),
  miniNextButton: document.querySelector("#miniNextButton"),
  fullPlayer: document.querySelector("#fullPlayer"),
  closePlayerButton: document.querySelector("#closePlayerButton"),
  lyricsTabButton: document.querySelector("#lyricsTabButton"),
  fullCover: document.querySelector("#fullCover"),
  fullTitle: document.querySelector("#fullTitle"),
  fullArtist: document.querySelector("#fullArtist"),
  progressInput: document.querySelector("#progressInput"),
  currentTime: document.querySelector("#currentTime"),
  durationTime: document.querySelector("#durationTime"),
  shuffleButton: document.querySelector("#shuffleButton"),
  previousButton: document.querySelector("#previousButton"),
  playButton: document.querySelector("#playButton"),
  nextButton: document.querySelector("#nextButton"),
  loopButton: document.querySelector("#loopButton"),
  fetchLyricsButton: document.querySelector("#fetchLyricsButton"),
  lyricsLines: document.querySelector("#lyricsLines"),
  queueStatus: document.querySelector("#queueStatus"),
  queueList: document.querySelector("#queueList")
};

const state = {
  tracks: [],
  queue: [],
  queueIndex: -1,
  currentTrack: null,
  isPlaying: false,
  shuffle: false,
  loopMode: "off",
  lyrics: [],
  activeLyricIndex: -1,
  autoQueueBusy: false,
  seeking: false
};

async function api(path) {
  const response = await fetch(path);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function trackMeta(track) {
  return [track.artist, track.album, track.genre].filter(Boolean).join(" - ") || "Unknown artist";
}

function initials(track) {
  const source = track?.artist || track?.title || "M";
  return source.trim().slice(0, 1).toUpperCase() || "M";
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function setMessage(element, message) {
  element.textContent = message || "";
}

function makeCover(track, className = "small") {
  const cover = document.createElement("span");
  cover.className = `cover ${className}`;
  if (track.coverUrl) {
    cover.style.backgroundImage = `url(${track.coverUrl})`;
    cover.style.backgroundSize = "cover";
  } else if (track.thumbnail) {
    cover.style.backgroundImage = `url(${track.thumbnail})`;
    cover.style.backgroundSize = "cover";
  } else {
    cover.textContent = initials(track);
  }
  return cover;
}

function makeTrackRow(track, action = "Play", onClick = null) {
  const button = document.createElement("button");
  button.className = "track-row";
  button.type = "button";
  if (state.currentTrack?.id === track.id) button.classList.add("is-current");

  const text = document.createElement("span");
  const title = document.createElement("strong");
  title.className = "track-title";
  title.textContent = track.title;
  const meta = document.createElement("span");
  meta.className = "track-meta";
  meta.textContent = trackMeta(track);
  text.append(title, meta);

  const actionEl = document.createElement("span");
  actionEl.className = "track-action";
  actionEl.textContent = action;

  button.append(makeCover(track), text, actionEl);
  if (onClick) {
    button.addEventListener("click", onClick);
  }
  return button;
}

function renderTrackList(container, tracks, emptyText, action = "Play", onClickFactory = null) {
  container.replaceChildren();
  if (!tracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  tracks.forEach((track, index) => {
    const onClick = onClickFactory ? onClickFactory(track, index) : () => startQueue(tracks, index);
    container.append(makeTrackRow(track, action, onClick));
  });
}

function renderHome() {
  const quick = state.tracks.slice(0, 8);
  const keep = state.tracks
    .filter((track) => track.hasCache || track.durationSeconds)
    .slice(0, 10);

  els.homeStatus.textContent = `${state.tracks.length} tracks`;
  renderTrackList(els.quickPicks, quick, "Scan your music folder to fill quick picks.");

  els.keepListening.replaceChildren();
  const railTracks = keep.length ? keep : state.tracks.slice(0, 8);
  if (!railTracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No library tracks yet.";
    els.keepListening.append(empty);
    return;
  }

  railTracks.forEach((track, index) => {
    const card = document.createElement("button");
    card.className = "album-card";
    card.type = "button";
    const title = document.createElement("strong");
    title.textContent = track.title;
    const meta = document.createElement("span");
    meta.textContent = track.artist || "Local track";
    card.append(makeCover(track, ""), title, meta);
    card.addEventListener("click", () => startQueue(railTracks, index));
    els.keepListening.append(card);
  });
}

function renderLibrary() {
  const query = els.libraryInput.value.trim().toLowerCase();
  const tracks = query
    ? state.tracks.filter((track) => `${track.title} ${track.artist || ""} ${track.album || ""} ${track.genre || ""}`.toLowerCase().includes(query))
    : state.tracks;
  renderTrackList(els.libraryTracks, tracks, "No indexed songs yet. Tap Scan on Home.");
}

function renderQueue() {
  els.queueStatus.textContent = state.queue.length
    ? `${Math.max(state.queue.length - state.queueIndex - 1, 0)} queued next`
    : "Auto radio on";
  renderTrackList(els.queueList, state.queue, "Your queue will appear here.", "Queue");
}

function renderPlayer() {
  const track = state.currentTrack;
  const hasTrack = Boolean(track);
  els.miniPlayer.hidden = !hasTrack;

  if (track) {
    if (track.coverUrl) {
      els.miniCover.style.backgroundImage = `url(${track.coverUrl})`;
      els.miniCover.style.backgroundSize = "cover";
      els.miniCover.textContent = "";
      els.fullCover.style.backgroundImage = `url(${track.coverUrl})`;
      els.fullCover.style.backgroundSize = "cover";
      els.fullCover.textContent = "";
    } else {
      els.miniCover.style.backgroundImage = "none";
      els.fullCover.style.backgroundImage = "none";
      els.miniCover.textContent = initials(track);
      els.fullCover.textContent = initials(track);
    }
    els.miniTitle.textContent = track.title;
    els.miniArtist.textContent = trackMeta(track);
    els.fullTitle.textContent = track.title;
    els.fullArtist.textContent = trackMeta(track);
  }

  const playLabel = state.isPlaying ? "Pause" : "Play";
  els.playButton.textContent = playLabel;
  els.miniPlayButton.textContent = playLabel;
  els.shuffleButton.textContent = state.shuffle ? "Shuffle On" : "Shuffle Off";
  els.shuffleButton.classList.toggle("is-active", state.shuffle);
  els.loopButton.textContent = state.loopMode === "one"
    ? "Loop One"
    : state.loopMode === "queue"
      ? "Loop Queue"
      : "Loop Off";
  els.loopButton.classList.toggle("is-active", state.loopMode !== "off");

  renderHome();
  renderLibrary();
  renderQueue();
}

async function loadLibrary() {
  const data = await api("/library");
  state.tracks = data.tracks || [];
  renderHome();
  renderLibrary();
}

async function scanLibrary() {
  els.refreshButton.disabled = true;
  els.homeStatus.textContent = "Scanning";
  try {
    await api("/scan");
    await loadLibrary();
  } catch (error) {
    els.homeStatus.textContent = error.message;
  } finally {
    els.refreshButton.disabled = false;
  }
}

async function runSearch() {
  const query = els.searchInput.value.trim();
  if (!query) return;

  setMessage(els.searchMessage, "Searching local library...");
  els.remoteSearchResultsWrapper.hidden = true;
  try {
    const data = await api(`/search?q=${encodeURIComponent(query)}`);
    const tracks = data.tracks || [];
    renderTrackList(els.searchResults, tracks, "No local matches. Tap 'Search Remote' to find it online.");
    setMessage(els.searchMessage, tracks.length ? `${tracks.length} local matches` : "No local matches.");
  } catch (error) {
    setMessage(els.searchMessage, error.message);
  }
}

async function searchRemote() {
  const query = els.searchInput.value.trim();
  if (!query) return;

  els.resolveButton.disabled = true;
  setMessage(els.searchMessage, "Fetching remote results...");
  try {
    const data = await api(`/search-remote?q=${encodeURIComponent(query)}`);
    const results = data.results || [];
    
    els.remoteSearchResults.replaceChildren();
    if (!results.length) {
      setMessage(els.searchMessage, "No remote results found.");
    } else {
      setMessage(els.searchMessage, `Found ${results.length} remote results. Choose one to download.`);
      results.forEach((r) => {
        const trackObj = { title: r.title, artist: r.channel, thumbnail: r.thumbnail };
        const button = makeTrackRow(trackObj, "Download", () => resolveSpecificRemote(r.url));
        els.remoteSearchResults.append(button);
      });
      els.remoteSearchResultsWrapper.hidden = false;
    }
  } catch (error) {
    setMessage(els.searchMessage, error.message);
  } finally {
    els.resolveButton.disabled = false;
  }
}

async function resolveSpecificRemote(url) {
  setMessage(els.searchMessage, "Downloading selected track...");
  try {
    const data = await api(`/resolve?url=${encodeURIComponent(url)}`);
    const track = data.track;
    if (!state.tracks.some((item) => item.id === track.id)) {
      state.tracks.unshift(track);
    }
    startQueue([track], 0);
    setMessage(els.searchMessage, "Playing downloaded track.");
  } catch (error) {
    setMessage(els.searchMessage, error.message);
  }
}

function startQueue(tracks, index = 0) {
  if (!tracks.length) return;
  state.queue = [...tracks];
  state.queueIndex = index;
  playQueueIndex(index);
}

function playQueueIndex(index) {
  const track = state.queue[index];
  if (!track) return;

  state.queueIndex = index;
  state.currentTrack = track;
  state.activeLyricIndex = -1;
  state.lyrics = [];
  audio.src = track.streamUrl || `/stream?id=${encodeURIComponent(track.id)}`;
  audio.play().catch(() => {
    state.isPlaying = false;
    renderPlayer();
  });
  loadLyrics(track.id);
  ensureAutoQueue();
  renderPlayer();
}

function togglePlay() {
  if (!state.currentTrack && state.queue.length) {
    playQueueIndex(Math.max(state.queueIndex, 0));
    return;
  }

  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
}

function nextTrack() {
  if (!state.queue.length) return;
  if (state.shuffle && state.queue.length > 1) {
    let next = state.queueIndex;
    while (next === state.queueIndex) {
      next = Math.floor(Math.random() * state.queue.length);
    }
    playQueueIndex(next);
    return;
  }

  if (state.queueIndex < state.queue.length - 1) {
    playQueueIndex(state.queueIndex + 1);
  } else if (state.loopMode === "queue") {
    playQueueIndex(0);
  }
}

function previousTrack() {
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  if (state.queueIndex > 0) playQueueIndex(state.queueIndex - 1);
}

async function handleEnded() {
  if (state.loopMode === "one") {
    audio.currentTime = 0;
    await audio.play();
    return;
  }

  await ensureAutoQueue(0);
  const before = state.queueIndex;
  nextTrack();
  if (before === state.queueIndex && state.loopMode !== "queue") {
    state.isPlaying = false;
    renderPlayer();
  }
}

async function ensureAutoQueue(minRemaining = 3) {
  if (!state.currentTrack || state.autoQueueBusy) return;
  const remaining = state.queue.length - state.queueIndex - 1;
  if (remaining > minRemaining) return;

  state.autoQueueBusy = true;
  try {
    const exclude = state.queue.map((track) => track.id).join(",");
    const data = await api(`/queue/similar?id=${encodeURIComponent(state.currentTrack.id)}&exclude=${encodeURIComponent(exclude)}&limit=8`);
    const additions = (data.tracks || []).filter((track) => !state.queue.some((item) => item.id === track.id));
    state.queue.push(...additions);
    renderQueue();
  } catch {
    // Recommendation failures should never interrupt playback.
  } finally {
    state.autoQueueBusy = false;
  }
}

async function loadLyrics(trackId) {
  els.lyricsLines.innerHTML = '<p class="empty-state">Loading lyrics...</p>';
  try {
    const data = await api(`/lyrics?id=${encodeURIComponent(trackId)}`);
    state.lyrics = data.lines || [];
    renderLyrics();
  } catch {
    state.lyrics = [];
    renderLyrics();
  }
}

function renderLyrics() {
  els.lyricsLines.replaceChildren();
  if (!state.lyrics.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No synced .lrc file found for this track.";
    els.lyricsLines.append(empty);
    return;
  }

  state.lyrics.forEach((line, index) => {
    const element = document.createElement("p");
    element.className = "lyric-line";
    element.dataset.index = String(index);
    element.textContent = line.text;
    els.lyricsLines.append(element);
  });
  updateActiveLyric();
}

function updateActiveLyric() {
  if (!state.lyrics.length) return;
  const time = audio.currentTime;
  let active = 0;
  for (let index = 0; index < state.lyrics.length; index += 1) {
    if (state.lyrics[index].time <= time) active = index;
    else break;
  }
  if (active === state.activeLyricIndex) return;

  state.activeLyricIndex = active;
  const lines = [...els.lyricsLines.querySelectorAll(".lyric-line")];
  lines.forEach((line, index) => {
    line.classList.toggle("is-active", index === active);
    line.classList.toggle("is-near", Math.abs(index - active) === 1);
  });
  lines[active]?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateProgress() {
  const duration = audio.duration || 0;
  const current = audio.currentTime || 0;
  if (!state.seeking && duration) {
    els.progressInput.value = String(Math.round((current / duration) * 1000));
  }
  els.currentTime.textContent = formatTime(current);
  els.durationTime.textContent = formatTime(duration);
  updateActiveLyric();

  if (duration && duration - current < 35) {
    ensureAutoQueue();
  }
}

function setView(name) {
  views.forEach((view) => view.classList.toggle("is-active", view.dataset.view === name));
  navItems.forEach((item) => item.classList.toggle("is-active", item.dataset.tab === name));
}

function setPlayerPanel(name) {
  playerPanels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.playerPanel === name));
  playerTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.playerTab === name));
}

function openFullPlayer(panel = "now") {
  els.fullPlayer.classList.add("is-open");
  els.fullPlayer.setAttribute("aria-hidden", "false");
  setPlayerPanel(panel);
}

function closeFullPlayer() {
  els.fullPlayer.classList.remove("is-open");
  els.fullPlayer.setAttribute("aria-hidden", "true");
}

navItems.forEach((item) => item.addEventListener("click", () => setView(item.dataset.tab)));
playerTabs.forEach((tab) => tab.addEventListener("click", () => setPlayerPanel(tab.dataset.playerTab)));
els.refreshButton.addEventListener("click", scanLibrary);
els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});
els.resolveButton.addEventListener("click", searchRemote);
els.libraryFilter.addEventListener("input", renderLibrary);
els.openPlayerButton.addEventListener("click", () => openFullPlayer("now"));
els.closePlayerButton.addEventListener("click", closeFullPlayer);
els.lyricsTabButton.addEventListener("click", () => openFullPlayer("lyrics"));
els.playButton.addEventListener("click", togglePlay);
els.miniPlayButton.addEventListener("click", togglePlay);
els.nextButton.addEventListener("click", nextTrack);
els.miniNextButton.addEventListener("click", nextTrack);
els.previousButton.addEventListener("click", previousTrack);
els.shuffleButton.addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  renderPlayer();
});
els.loopButton.addEventListener("click", () => {
  state.loopMode = state.loopMode === "off" ? "one" : state.loopMode === "one" ? "queue" : "off";
  renderPlayer();
});

if (els.fetchLyricsButton) {
  els.fetchLyricsButton.addEventListener("click", async () => {
    if (!state.currentTrack) return;
    els.lyricsLines.innerHTML = '<p class="empty-state">Fetching lyrics from LRCLIB...</p>';
    els.fetchLyricsButton.disabled = true;
    try {
      const data = await api(`/lyrics/fetch?id=${encodeURIComponent(state.currentTrack.id)}`);
      state.lyrics = data.lines || [];
      renderLyrics();
    } catch (error) {
      state.lyrics = [];
      els.lyricsLines.innerHTML = `<p class="empty-state">${error.message}</p>`;
    } finally {
      els.fetchLyricsButton.disabled = false;
    }
  });
}

els.progressInput.addEventListener("input", () => {
  if (!audio.duration) return;
  state.seeking = true;
  audio.currentTime = (Number(els.progressInput.value) / 1000) * audio.duration;
});
els.progressInput.addEventListener("change", () => {
  state.seeking = false;
});

let touchStartY = null;
els.miniPlayer.addEventListener("touchstart", (event) => {
  touchStartY = event.changedTouches[0]?.clientY ?? null;
}, { passive: true });
els.miniPlayer.addEventListener("touchend", (event) => {
  const endY = event.changedTouches[0]?.clientY ?? null;
  if (touchStartY !== null && endY !== null && touchStartY - endY > 36) {
    openFullPlayer("now");
  }
  touchStartY = null;
}, { passive: true });

audio.addEventListener("play", () => {
  state.isPlaying = true;
  renderPlayer();
});
audio.addEventListener("pause", () => {
  state.isPlaying = false;
  renderPlayer();
});
audio.addEventListener("loadedmetadata", updateProgress);
audio.addEventListener("timeupdate", updateProgress);
audio.addEventListener("ended", handleEnded);

loadLibrary().catch((error) => {
  els.homeStatus.textContent = error.message;
});
