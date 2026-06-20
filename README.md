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

If `yt-dlp` is not on PATH but `python -m yt_dlp` works, configure:

```bash
export YT_DLP_BIN=python
export YT_DLP_BIN_ARGS="-m yt_dlp"
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
YT_DLP_BIN=yt-dlp
YT_DLP_BIN_ARGS=
YT_DLP_JS_RUNTIME=node
YT_DLP_REMOTE_COMPONENTS=ejs:github
YT_DLP_EXTRACTOR_ARGS=
YT_DLP_IMPERSONATE=
YT_DLP_COOKIES=
YT_DLP_COOKIES_FROM_BROWSER=
YT_DLP_OAUTH2=false
YT_DLP_CHROMIUM_FALLBACK=false
ENABLE_SOUNDCLOUD_FALLBACK=false
YT_DLP_FORMAT=bestaudio/best
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

When enabled, `/resolve` and `/search-and-play` can call `yt-dlp` for a missing query, save the downloaded audio into `MUSIC_DIR`, rescan, then stream it. The downloader forces `bestaudio/best` so it avoids video streams, prioritizes `official audio`, `topic`, and YouTube Music matches, then tries YouTube client fallbacks before failing loudly. SoundCloud fallback is now disabled by default because unofficial uploads are often remixes, slowed/reverb edits, or unrelated tracks. Use remote fetch only for content you have the right to download and stream.

If YouTube returns `HTTP Error 403` after installing yt-dlp, update yt-dlp and confirm remote EJS component access:

```bash
python -m pip install -U "yt-dlp[default]"
yt-dlp --js-runtimes node --remote-components ejs:github --simulate "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
```

If stable still fails on YouTube media downloads, try yt-dlp nightly:

```bash
python -m pip install -U --pre "yt-dlp[default]"
```

If a specific network/video still returns `HTTP Error 403`, the error returned by the app includes the last yt-dlp lines so you can see whether YouTube is asking for a PO token, EJS update, cookies, or a different client.

If YouTube requires an authenticated session for a specific track, provide cookies:

```bash
export YT_DLP_COOKIES="$HOME/youtube-cookies.txt"
```

Then open `/health` and check:

```json
"ytDlpCookiesConfigured": true,
"ytDlpCookiesFileExists": true
```

If `ytDlpCookiesFileExists` is `false`, the server process is not seeing your cookie file. Use an absolute path or `$HOME/...`; the app expands both before spawning yt-dlp.

Keep `YT_DLP_OAUTH2=false`; the yt-dlp wiki says YouTube OAuth no longer works and cookies should be used instead.

### YouTube PO Token Setup

YouTube is increasingly requiring PO tokens for playback media URLs. Cookies may prove you are logged in, but they do not always satisfy the media URL request. The yt-dlp wiki currently recommends using the `mweb` client with a PO-token provider for this case. The bgutil provider has two pieces: a Python plugin for yt-dlp and a local token server that must be running.

Install the yt-dlp plugin:

```bash
python -m pip install -U bgutil-ytdlp-pot-provider
```

Install and build the local bgutil provider server:

```bash
cd ~
pkg install git nodejs clang make pkg-config libvips xorgproto -y
mkdir -p ~/.gyp
printf "{'variables':{'android_ndk_path':''}}\n" > ~/.gyp/include.gypi
git clone --single-branch --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd ~/bgutil-ytdlp-pot-provider/server
npm ci
npx tsc
```

Run the provider server in a separate Termux session:

```bash
cd ~/bgutil-ytdlp-pot-provider/server
node build/main.js
```

Or run it in the background:

```bash
cd ~/bgutil-ytdlp-pot-provider/server
nohup node build/main.js > ~/bgutil-pot.log 2>&1 &
curl http://127.0.0.1:4416/ping
```

Then keep your normal app config:

```bash
export ENABLE_REMOTE_FETCH=true
export YT_DLP_COOKIES="$HOME/storage/shared/Music/cookies.txt"
export YT_DLP_EXTRACTOR_ARGS="youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"
```

The app also tries an internal `mweb` plan when `YT_DLP_EXTRACTOR_ARGS` is empty, but the provider server must still be reachable for bgutil to generate tokens. If you see `Error reaching GET http://127.0.0.1:4416/ping`, the provider server is not running or crashed.

Only enable SoundCloud if you explicitly want unofficial matches:

```bash
export ENABLE_SOUNDCLOUD_FALLBACK=true
```

For browser/TLS fingerprinting cases, install yt-dlp with the `curl-cffi` extra and set `YT_DLP_IMPERSONATE=chrome`.

The experimental Chromium fallback is disabled by default because it is heavy on Termux and requires a real Chromium executable. Enable it only when you have Chromium installed and want to debug direct browser interception:

```bash
export YT_DLP_CHROMIUM_FALLBACK=true
export CHROMIUM_PATH="/data/data/com.termux/files/usr/bin/chromium"
```

## Synced Lyrics

Place `.lrc` files beside your songs using the same base filename:

```text
Music/My Song.mp3
Music/My Song.lrc
```

The full-screen player will animate the active lyric line automatically.

## Long-Running Process

### Option A: Manual PM2 Setup
Install PM2 on the phone:

```bash
npm install pm2 -g
pm2 start src/server.js --name mobile-music-server
pm2 save
```

## Shared Storage (Recommended)
If you want to use your phone's default Music folder (so other apps like VLC or Oto Music can also play the downloaded music), give Termux storage permissions first:

```bash
termux-setup-storage
```
*(A prompt will appear on your phone asking for storage access. Tap "Allow".)*

Then, create a `.env` file in the project directory to tell the server to use that folder, and optionally enable yt-dlp to download missing songs:

```bash
cd ~/mobile-music-server
echo 'MUSIC_DIR="/data/data/com.termux/files/home/storage/shared/Music"' > .env
echo 'ENABLE_REMOTE_FETCH=true' >> .env
```

Now any music you download via Chrome to your `Music` folder will be discovered by the server when you hit "Scan library". Any songs the server downloads via yt-dlp will also go straight into this `Music` folder.

## Local Development

```bash
npm install
npm run check
npm start
```

The first stream of a track can take a moment while `ffmpeg` creates the cached `.opus` file. Later plays use the cache directly.
