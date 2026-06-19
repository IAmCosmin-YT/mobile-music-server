# Mobile Music Server

A small personal music server for an old Android phone running Termux. It scans a local music folder, searches your library, compresses tracks to Opus on first play with `ffmpeg`, stores track metadata in a JSON database file, caches the compressed files, and serves a Material-style mobile web player.

The web app includes Home, Search, and Library tabs, a persistent mini-player, a full-screen now-playing view, shuffle and loop modes, synced `.lrc` lyrics, and an auto-extending dynamic queue for radio-style playback.

## Termux Setup

```bash
pkg update
pkg install nodejs ffmpeg python git -y
```

Copy this project to the phone, then install dependencies:

```bash
npm install
```

Optional remote fallback uses `yt-dlp` and is disabled by default:

```bash
python -m pip install -U "yt-dlp[default]"
yt-dlp --version
```

## Configuration

Create a `.env` file or export environment variables before starting:

```bash
PORT=3000
MUSIC_DIR=./music
CACHE_DIR=./cache
DB_PATH=./music-db.json
ENABLE_REMOTE_FETCH=false
OPUS_BITRATE=64k
YT_DLP_JS_RUNTIME=node
YT_DLP_REMOTE_COMPONENTS=ejs:github
YT_DLP_COOKIES=
YT_DLP_COOKIES_FROM_BROWSER=
YT_DLP_FORMAT=
```

On Android, a common music path after `termux-setup-storage` is:

```bash
export MUSIC_DIR="$HOME/storage/shared/Music"
```

## Run

```bash
npm start
```

Open the player from another device on the same Wi-Fi:

```text
http://<phone-ip>:3000/
```

Find the phone IP in Termux:

```bash
ifconfig
```

Look for the `wlan0` address, usually like `192.168.1.x`.

## API

- `GET /health` - server status and active paths.
- `GET /scan` - scan `MUSIC_DIR` and index supported audio files.
- `GET /library` - list indexed tracks for the Home and Library tabs.
- `GET /search?q=query` - fuzzy search indexed tracks.
- `GET /resolve?q=query` - find a local match or, when enabled, fetch a remote song request.
- `GET /stream?id=trackId` - stream cached Opus, creating it with `ffmpeg` on first play.
- `GET /lyrics?id=trackId` - read a synced `.lrc` file beside the audio file.
- `GET /queue/similar?id=trackId` - return local recommendations for the dynamic queue.
- `GET /search-and-play?q=query` - redirect to the first playable match.

## Remote Fetch

Remote fetch is off unless explicitly enabled:

```bash
export ENABLE_REMOTE_FETCH=true
```

When enabled, `/resolve` and `/search-and-play` can call `yt-dlp` for a missing query, save the downloaded audio into `MUSIC_DIR`, rescan, then stream it. The downloader now lets yt-dlp handle search, client selection, and format selection natively. It tries staged targets in this order: `official audio`, `topic`, `album track`, `audio`, then a plain search fallback. Each successful result is post-processed to MP3 by ffmpeg. Use this only for content you have the right to download and stream.

If YouTube returns `HTTP Error 403` after installing yt-dlp, update yt-dlp and confirm remote EJS component access:

```bash
python -m pip install -U "yt-dlp[default]"
yt-dlp --js-runtimes node --remote-components ejs:github --simulate "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
```

If a specific network/video still returns `HTTP Error 403`, the error returned by the app includes the last yt-dlp lines so you can see whether YouTube is asking for a PO token, EJS update, cookies, or a different client.

If YouTube requires an authenticated session for a specific track, provide cookies:

```bash
export YT_DLP_COOKIES="$HOME/youtube-cookies.txt"
```

## Synced Lyrics

Place `.lrc` files beside your songs using the same base filename:

```text
Music/My Song.mp3
Music/My Song.lrc
```

The full-screen player will animate the active lyric line automatically.

## Long-Running Process

Install PM2 on the phone:

```bash
npm install pm2 -g
pm2 start src/server.js --name mobile-music-server
pm2 save
```

## Local Development

```bash
npm install
npm run check
npm start
```

The first stream of a track can take a moment while `ffmpeg` creates the cached `.opus` file. Later plays use the cache directly.
