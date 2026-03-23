# Autostart

This file provides boot autostart options. The default is to autostart only the server. Open the web UI manually at `http://localhost:5173`.

## Windows (Task Scheduler)
1. Optional, build once
```
npm run build -w apps/server
```
2. Open Task Scheduler and create a task
3. Action: Start a program
4. Program/script: `node`
5. Add arguments:
```
apps/server/dist/index.js
```
6. Start in: the repo root directory

If you want dev mode, use this argument instead:
```
node_modules/npm/bin/npm-cli.js run dev -w apps/server
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
