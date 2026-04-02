# Autostart

This file provides reliable boot autostart options.

Preferred on Windows:
- Use the built-in scripts in `scripts/`
- They create hidden Scheduled Tasks (no console window)
- They remove old Startup-folder entries from legacy setup

## Windows (Recommended)
1. Build once
```powershell
npm install
npm run build -w apps/server
npm run build -w apps/web
```
2. Install hidden autostart for both server and web
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-all.ps1
```
3. Verify
```powershell
Get-ScheduledTask -TaskName "ClipNest Server","ClipNest Web","ClipNest Launcher" | Select-Object TaskName,State
```
4. Health check
```powershell
Invoke-RestMethod http://localhost:5174/api/health
Invoke-RestMethod http://127.0.0.1:5180/api/health
```

Open web UI:
- `http://localhost:5173`

### Server-only / Web-only installers
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-web.ps1
```

### Logs
- `logs/server.log`
- `logs/web.log`
- `logs/launcher.log` (if launcher is started with script)

## Launcher (for extension one-click start/restart)
Run launcher manually:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-run-launcher.ps1
```

Default launcher endpoint:
- `http://127.0.0.1:5180`

Health check:
```powershell
Invoke-RestMethod http://127.0.0.1:5180/api/health
```

Optional token auth:
- set env var `LAUNCHER_TOKEN` before starting launcher
- then fill the same token in extension settings (`Launcher Token`)

### Remove tasks
```powershell
Unregister-ScheduledTask -TaskName "ClipNest Server" -Confirm:$false
Unregister-ScheduledTask -TaskName "ClipNest Web" -Confirm:$false
Unregister-ScheduledTask -TaskName "ClipNest Launcher" -Confirm:$false
```

### Troubleshooting
- If web is missing, ensure `apps/web/dist/index.html` exists.
- If server is missing, ensure `apps/server/dist/index.js` exists.
- Web uses fixed `5173` now (strict mode). If that port is occupied, task will fail fast and write reason to `logs/web.log`.
- Check who occupies `5173`:
```powershell
Get-NetTCPConnection -State Listen -LocalPort 5173 | Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process -Id <OwningProcess>
```
- Reinstall all autostart tasks after upgrades:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-all.ps1
```

## macOS (launchd)
1. Optional, build once
```
npm run build -w apps/server
```
2. Create `~/Library/LaunchAgents/com.clipnest.server.plist`
```
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.clipnest.server</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/path/to/clipnest/apps/server/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/clipnest</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/clipnest/logs/server.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/clipnest/logs/server.log</string>
  </dict>
</plist>
```
3. Load it
```
launchctl load ~/Library/LaunchAgents/com.clipnest.server.plist
```

## Linux (systemd --user)
1. Optional, build once
```
npm run build -w apps/server
```
2. Create `~/.config/systemd/user/clipnest-server.service`
```
[Unit]
Description=ClipNest Server

[Service]
Type=simple
WorkingDirectory=/path/to/clipnest
ExecStart=/usr/bin/node /path/to/clipnest/apps/server/dist/index.js
Restart=on-failure
Environment=XIC_LOG_LEVEL=info

[Install]
WantedBy=default.target
```
3. Enable and start
```
systemctl --user daemon-reload
systemctl --user enable --now clipnest-server
```
