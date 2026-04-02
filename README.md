# ClipNest

ClipNest is a local-first image and video collector for X and other sites. The extension captures media from your logged-in browser session, saves files locally, and indexes them with SQLite. The web UI lets you browse, filter, tag, and archive.

## Features
- Manual save, batch save, and auto tasks
- Local files with dedupe and SQLite index
- Library UI for filters, tags, collections, and source backtracking
- Recycle bin with restore, permanent delete, and timed cleanup
- No official X API required

## Architecture
- `apps/server`: local HTTP API + downloader + thumbnails + SQLite
- `apps/web`: local library UI
- `apps/extension`: Chromium MV3 extension
- `apps/launcher`: local launcher API (start/restart server from extension)

## Quick Start
1. Install deps
```
npm install
```
2. Start server and web
```
npm run dev
```
3. Start launcher (new terminal)
```
npm run dev:launcher
```
4. Build and load the extension
```
npm run build -w apps/extension
```
Open Chrome or Edge extensions page, enable Developer mode, load `apps/extension/dist`.

Default ports
- Server: `http://localhost:5174`
- Web UI: `http://localhost:5173`
- Launcher: `http://127.0.0.1:5180`

Health check
```
curl http://localhost:5174/api/health
```
Launcher check
```
curl http://127.0.0.1:5180/api/health
```

Extension launcher buttons
- Open extension popup and use `启动后端` or `重启后端`
- Configure launcher URL/token in extension options if you changed defaults

## Data Directory
Default managed data directory
- Windows: `%USERPROFILE%\.clipnest\`
- macOS/Linux: `~/.clipnest/`

Legacy data directory fallback
- If `~/.x-image-collector/` exists and `~/.clipnest/` does not, ClipNest will use the legacy directory automatically.

When a library root is configured in Settings, ClipNest will migrate its managed data into the library root:
- `<LibraryRoot>/_unarchived/`: files that are saved but not yet archived into albums
- `<LibraryRoot>/.clipnest/db.sqlite`: SQLite index
- `<LibraryRoot>/.clipnest/thumbs/`: thumbnails
- `<LibraryRoot>/.clipnest/trash/`: recycle bin payload and thumbnails

Archive mapping
- Every album maps to a real folder under the library root
- Moving an item into an album moves the underlying file on disk
- Deleting an item moves it into ClipNest trash first, then optional timed cleanup can permanently remove it

Legacy folder rename
- If your existing library root folder is literally named `Twitter`, ClipNest will try a one-time safe rename to `ClipNest` on startup

## Environment Variables
Common settings
- Env vars keep the `XIC_` prefix for compatibility.
- `XIC_DATA_DIR`: override data directory
- `PORT`: server port, default `5174`
- `XIC_PROXY`: proxy URL, default `http://127.0.0.1:7890`, set `off` to disable
- `XIC_MAX_CONCURRENCY`: max concurrent downloads
- `XIC_TIMEOUT_MS`: request timeout
- `XIC_UA`: download User-Agent
- `XIC_LOG_LEVEL`: log level, `debug` `info` `warn` `error`
- `XIC_DEBUG_DOWNLOAD`: download detail logs, set `1` to enable

## Logging
Log level is controlled by `XIC_LOG_LEVEL` and defaults to `info`. Download details can be enabled with `XIC_DEBUG_DOWNLOAD=1`.

Export logs
Windows PowerShell
```
$env:XIC_LOG_LEVEL="debug"
npm run dev -w apps/server > server.log 2>&1
```

macOS/Linux
```
XIC_LOG_LEVEL=debug npm run dev -w apps/server | tee server.log
```

## Autostart
Autostart setup is documented in [docs/AUTOSTART.md](docs/AUTOSTART.md).

## Extension
Extension loading and site extension notes are in [apps/extension/EXTENDING_SITES.md](apps/extension/EXTENDING_SITES.md).

## Troubleshooting
- If saves fail, check server health at `/api/health`
- Disable proxy if needed: `XIC_PROXY=off`
- Video thumbnails require `ffmpeg` in PATH

## License
TBD
