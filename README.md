# Mobile Music Server

A small personal music server for an old Android phone running Termux. It scans a local music folder, searches your library, compresses tracks to Opus on first play with `ffmpeg`, stores track metadata in a JSON database file, caches the compressed files, and serves a simple browser player.

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
pip install yt-dlp
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
- `GET /search?q=query` - fuzzy search indexed tracks.
- `GET /stream?id=trackId` - stream cached Opus, creating it with `ffmpeg` on first play.
- `GET /search-and-play?q=query` - redirect to the first playable match.

## Remote Fetch

Remote fetch is off unless explicitly enabled:

```bash
export ENABLE_REMOTE_FETCH=true
```

When enabled, `/search-and-play` can call `yt-dlp` for a missing query, save the downloaded audio into `MUSIC_DIR`, rescan, then stream it. Use this only for content you have the right to download and stream.

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
