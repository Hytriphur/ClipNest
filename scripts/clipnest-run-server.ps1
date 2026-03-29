param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Proxy = "http://127.0.0.1:7890",
  [string]$LogLevel = "info",
  [int]$Port = 5174
)

$ErrorActionPreference = "Stop"
# Avoid treating native command stderr output as terminating errors in task mode.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Node = (Get-Command node -ErrorAction Stop).Source
$ServerEntry = Join-Path $RepoRoot "apps\\server\\dist\\index.js"
if (!(Test-Path $ServerEntry)) {
  throw "Server build not found: $ServerEntry. Run: npm run build -w apps/server"
}

$LogsDir = Join-Path $RepoRoot "logs"
if (!(Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir | Out-Null
}
$LogFile = Join-Path $LogsDir "server.log"

function Write-LogLine([string]$line) {
  try {
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  } catch {
    # Do not fail startup if log file is temporarily locked.
  }
}

$env:XIC_LOG_LEVEL = $LogLevel
$env:PORT = [string]$Port
if ($Proxy -and $Proxy -ne "off") {
  $env:XIC_PROXY = $Proxy
} else {
  Remove-Item Env:XIC_PROXY -ErrorAction SilentlyContinue
}

Write-LogLine ("[{0}] clipnest server starting" -f (Get-Date -Format "s"))
& $Node $ServerEntry >> $LogFile 2>&1
