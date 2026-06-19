const statusEl = document.querySelector("#status");
const messageEl = document.querySelector("#message");
const resultsEl = document.querySelector("#results");
const form = document.querySelector("#searchForm");
const queryEl = document.querySelector("#query");
const audioEl = document.querySelector("#audio");
const nowPlayingEl = document.querySelector("#nowPlaying");
const scanButton = document.querySelector("#scanButton");

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = !text;
}

async function api(path) {
  const response = await fetch(path);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

function trackMeta(track) {
  return [track.artist, track.album].filter(Boolean).join(" - ") || "Unknown artist";
}

function renderResults(tracks) {
  resultsEl.replaceChildren();

  if (!tracks.length) {
    showMessage("No local matches found.");
    return;
  }

  showMessage("");
  for (const track of tracks) {
    const item = document.createElement("article");
    item.className = "track";

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = track.title;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = trackMeta(track);

    text.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Play";
    button.addEventListener("click", () => {
      audioEl.src = `/stream?id=${encodeURIComponent(track.id)}`;
      audioEl.play();
      nowPlayingEl.textContent = `${track.title} - ${trackMeta(track)}`;
    });

    item.append(text, button);
    resultsEl.append(item);
  }
}

async function loadHealth() {
  try {
    const health = await api("/health");
    statusEl.textContent = health.remoteFetchEnabled
      ? `Ready. Remote fetch enabled.`
      : `Ready. Local library mode.`;
  } catch (error) {
    statusEl.textContent = `Server check failed: ${error.message}`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryEl.value.trim();
  if (!query) return;

  showMessage("Searching...");
  try {
    const data = await api(`/search?q=${encodeURIComponent(query)}`);
    renderResults(data.tracks);
  } catch (error) {
    showMessage(error.message);
  }
});

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  showMessage("Scanning music folder...");
  try {
    const data = await api("/scan");
    showMessage(`Scan complete. Indexed ${data.count} track${data.count === 1 ? "" : "s"}.`);
  } catch (error) {
    showMessage(error.message);
  } finally {
    scanButton.disabled = false;
  }
});

loadHealth();
