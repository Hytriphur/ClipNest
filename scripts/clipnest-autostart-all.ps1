$ErrorActionPreference = "Stop"

# ClipNest autostart (server + web) using the Startup folder (Windows)
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-all.ps1

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Node = (Get-Command node -ErrorAction Stop).Source

$ServerEntry = Join-Path $RepoRoot "apps\\server\\dist\\index.js"
if (!(Test-Path $ServerEntry)) {
  Write-Host "Cannot find server build: $ServerEntry"
  Write-Host "Run: npm run build -w apps/server"
  exit 1
}

$WebDist = Join-Path $RepoRoot "apps\\web\\dist\\index.html"
if (!(Test-Path $WebDist)) {
  Write-Host "Cannot find web build: $WebDist"
  Write-Host "Run: npm run build -w apps/web"
  exit 1
}

$ViteEntry = Join-Path $RepoRoot "node_modules\\vite\\bin\\vite.js"
if (!(Test-Path $ViteEntry)) {
  $ViteAlt = Join-Path $RepoRoot "apps\\web\\node_modules\\vite\\bin\\vite.js"
  if (Test-Path $ViteAlt) {
    $ViteEntry = $ViteAlt
  } else {
    Write-Host "Cannot find Vite entry: $ViteEntry"
    Write-Host "Run: npm install"
    exit 1
  }
}

# Editable settings
$Proxy = "http://127.0.0.1:7890" # set to "off" or "" to disable
$LogLevel = "info"
$Port = "5174"
$WebPort = "5173"

$EnvLines = @(
  "set XIC_LOG_LEVEL=$LogLevel",
  "set PORT=$Port"
)
if ($Proxy -and $Proxy -ne "off") {
  $EnvLines += "set XIC_PROXY=$Proxy"
}

$StartupCmd = Join-Path $RepoRoot "scripts\\clipnest-startup.cmd"
$StartupDir = [Environment]::GetFolderPath("Startup")

$CmdLines = @(
  "@echo off",
  "cd /d `"$RepoRoot`"",
  ($EnvLines -join " && ")
)

$ServerLine = "start `"ClipNest Server`" /min `"$Node`" `"$ServerEntry`""
$WebLine = "start `"ClipNest Web`" /min `"$Node`" `"$ViteEntry`" preview -w apps/web --host 127.0.0.1 --port $WebPort"

$CmdLines += $ServerLine
$CmdLines += $WebLine
$CmdLines += "exit /b 0"

Set-Content -Path $StartupCmd -Value $CmdLines -Encoding ASCII
Copy-Item -Force $StartupCmd (Join-Path $StartupDir "ClipNest Startup.cmd")

Write-Host "Done."
Write-Host "Startup script installed at:"
Write-Host "  $StartupDir\\ClipNest Startup.cmd"
Write-Host "You can test it now by running:"
Write-Host "  `"$StartupDir\\ClipNest Startup.cmd`""
