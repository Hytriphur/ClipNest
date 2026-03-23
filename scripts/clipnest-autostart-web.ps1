$ErrorActionPreference = "Stop"

# ClipNest web UI autostart task for current user (Windows Task Scheduler)
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-web.ps1

$RepoRoot = "G:\\projects\\x-image-collector"
$TaskName = "ClipNest Web"
$WebPort = "5173"

$NpmCli = Join-Path $RepoRoot "node_modules\\npm\\bin\\npm-cli.js"
if (!(Test-Path $NpmCli)) {
  Write-Host "Cannot find npm-cli at: $NpmCli"
  Write-Host "Run: npm install"
  exit 1
}

Write-Host "Creating scheduled task '$TaskName' (Run at logon for current user)..."

# Use Vite preview for a stable, no-watch web server.
$Cmd = "cd /d `"$RepoRoot`" && node `"$NpmCli`" run preview -w apps/web -- --host 127.0.0.1 --port $WebPort"

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "$TaskName" /TR "cmd.exe /c $Cmd" | Out-Null

Write-Host "Done. Build the web UI once before first run:"
Write-Host "  npm run build -w apps/web"
Write-Host "Verify with:"
Write-Host "  schtasks /Query /TN `"$TaskName`""
Write-Host "Start immediately with:"
Write-Host "  schtasks /Run /TN `"$TaskName`""
Write-Host "Delete with:"
Write-Host "  schtasks /Delete /TN `"$TaskName`" /F"
