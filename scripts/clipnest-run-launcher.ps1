param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ListenHost = "127.0.0.1",
  [int]$Port = 5180,
  [string]$Token = "",
  [string]$ServerUrl = "http://127.0.0.1:5174",
  [string]$WebUrl = "http://127.0.0.1:5173"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Node = (Get-Command node -ErrorAction Stop).Source
$LauncherEntry = Join-Path $RepoRoot "apps\\launcher\\src\\index.mjs"
if (!(Test-Path $LauncherEntry)) {
  throw "Launcher entry not found: $LauncherEntry"
}

$LogsDir = Join-Path $RepoRoot "logs"
if (!(Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir | Out-Null
}
$LogFile = Join-Path $LogsDir "launcher.log"

function Ensure-Utf8LogFile([string]$path) {
  if (!(Test-Path $path)) {
    try {
      [System.IO.File]::WriteAllText($path, "", [System.Text.Encoding]::UTF8)
    } catch {
      # ignore
    }
    return
  }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasNull = $false
    foreach ($b in $bytes) {
      if ($b -eq 0) {
        $hasNull = $true
        break
      }
    }
    if ($hasNull) {
      $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
      $backup = "$path.legacy-$stamp"
      Move-Item -LiteralPath $path -Destination $backup -Force
      [System.IO.File]::WriteAllText($path, "", [System.Text.Encoding]::UTF8)
    }
  } catch {
    # ignore
  }
}

function Write-LogLine([string]$line) {
  try {
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  } catch {
    # ignore temporary lock
  }
}

Ensure-Utf8LogFile -path $LogFile

$env:LAUNCHER_HOST = $ListenHost
$env:LAUNCHER_PORT = [string]$Port
$env:CLIPNEST_REPO_ROOT = $RepoRoot
$env:CLIPNEST_SERVER_URL = $ServerUrl
$env:CLIPNEST_WEB_URL = $WebUrl
if ($Token) {
  $env:LAUNCHER_TOKEN = $Token
} else {
  Remove-Item Env:LAUNCHER_TOKEN -ErrorAction SilentlyContinue
}

Write-LogLine ("[{0}] clipnest launcher starting" -f (Get-Date -Format "s"))
$cmd = ('"{0}" "{1}" >> "{2}" 2>&1' -f $Node, $LauncherEntry, $LogFile)
& cmd.exe /d /c $cmd
