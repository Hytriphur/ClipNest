# ClipNest: Governance (v1)

## Goal
Build a **local-first** product to help users explore and quickly save images/GIF/video from X (x.com) into a personal library with:

- Fast capture (manual + batch + auto tasks)
- Local archive (files on disk + SQLite index)
- Comfortable UI for browsing, filtering, tagging, collections, and source backtracking

**No official X API is used in v1.** Collection is done from inside the user's **already logged-in** browser session via a Chromium extension.

## Non-Goals (v1)
- No cloud sync, no accounts, no multi-device support
- No headless, unattended cron-like scraping service (planned v2)
- No promise of long-term stability against X DOM/anti-automation changes

## Repo Structure
- `apps/server`: local HTTP API + downloader + thumbnails + SQLite
- `apps/web`: local library UI (React + Vite)
- `apps/extension`: Chrome/Edge MV3 extension (collector + task runner)

## Environment Requirements
- Node `v22.x` (current dev machine: `v22.13.0`)
- npm `10.x` (current dev machine: `10.9.2`)

Optional but strongly recommended:
- `ffmpeg` in PATH for video/GIF (mp4) thumbnail extraction

Notes on native deps:
- `sharp` is used for image thumbnails.
- SQLite driver is native (Windows may require build tools if prebuilt binaries are unavailable).

## Data Directory (Local-First)
Default data dir is under the current OS user's home:

- Windows: `%USERPROFILE%\\.clipnest\\`
- macOS/Linux: `~/.clipnest/`

Legacy fallback:
- If `~/.x-image-collector/` exists and `~/.clipnest/` does not, ClipNest will use the legacy directory automatically.

It contains:
- `db.sqlite` (SQLite index)
- `media/` (original files)
- `thumbs/` (thumbnails)

Override with env var:
- `XIC_DATA_DIR=...`

## Security & Privacy Principles
- We do **not** store X account credentials.
- Collection runs inside the user's browser session.
- All media is stored locally by default.
- Provide clear instructions for deleting the local data dir if the user wants to wipe everything.

## Compliance Notes (Important)
Users are responsible for ensuring their usage complies with:
- X Terms of Service
- local laws and regulations

To reduce risk:
- conservative defaults for rate limiting and concurrency
- no credential storage

## How To Run (Dev)
1. Install deps from repo root:
   - `npm install`
2. Start server + web UI:
   - `npm run dev`
3. Load extension:
   - Build once: `npm run build -w apps/extension`
   - In Chrome/Edge: Extensions -> Developer mode -> Load unpacked -> select `apps/extension/dist`

Default ports:
- Server: `http://localhost:5174`
- Web UI: `http://localhost:5173`

## Conventions
- TypeScript strict mode
- Prefer small, testable pure functions for URL normalization and DOM extraction
- API is `/api/*` and must remain backwards-compatible within v1
