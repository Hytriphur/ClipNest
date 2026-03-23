$ErrorActionPreference = "Stop"

# ClipNest autostart task for current user (Windows Task Scheduler)
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart.ps1

$RepoRoot = "G:\\projects\\x-image-collector"
$TaskName = "ClipNest Server"
$Proxy = "http://127.0.0.1:7890" # set to "off" to disable proxy
$LogLevel = "info"
$Port = "5174"

$ServerEntry = Join-Path $RepoRoot "apps\\server\\dist\\index.js"
if (!(Test-Path $ServerEntry)) {
  Write-Host "Cannot find server build: $ServerEntry"
  Write-Host "Run: npm run build -w apps/server"
  exit 1
}

Write-Host "Creating scheduled task '$TaskName' (Run at logon for current user)..."

$EnvProxyPart = ""
if ($Proxy -and $Proxy.Trim().Length -gt 0) {
  $EnvProxyPart = "set XIC_PROXY=$Proxy && "
}

$Cmd = "cd /d `"$RepoRoot`" && set XIC_LOG_LEVEL=$LogLevel && set PORT=$Port && $EnvProxyPart node apps\\server\\dist\\index.js"
$Cmd = $Cmd -replace "\s+$", ""

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "$TaskName" /TR "cmd.exe /c $Cmd" | Out-Null

Write-Host "Done. You can verify with:"
Write-Host "  schtasks /Query /TN `"$TaskName`""
Write-Host "Start immediately with:"
Write-Host "  schtasks /Run /TN `"$TaskName`""
Write-Host "Delete with:"
Write-Host "  schtasks /Delete /TN `"$TaskName`" /F"
