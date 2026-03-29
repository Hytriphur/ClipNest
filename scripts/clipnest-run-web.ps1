param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$WebPort = 5173
)

$ErrorActionPreference = "Stop"
# Avoid treating native command stderr output as terminating errors in task mode.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Node = (Get-Command node -ErrorAction Stop).Source
$ViteEntry = Join-Path $RepoRoot "node_modules\\vite\\bin\\vite.js"
if (!(Test-Path $ViteEntry)) {
  $ViteAlt = Join-Path $RepoRoot "apps\\web\\node_modules\\vite\\bin\\vite.js"
  if (Test-Path $ViteAlt) {
    $ViteEntry = $ViteAlt
  } else {
    throw "Vite entry not found. Run: npm install"
  }
}

$WebDist = Join-Path $RepoRoot "apps\\web\\dist\\index.html"
if (!(Test-Path $WebDist)) {
  throw "Web build not found: $WebDist. Run: npm run build -w apps/web"
}

$LogsDir = Join-Path $RepoRoot "logs"
if (!(Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir | Out-Null
}
$LogFile = Join-Path $LogsDir "web.log"

function Write-LogLine([string]$line) {
  try {
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  } catch {
    # Do not fail startup if log file is temporarily locked.
  }
}

Write-LogLine ("[{0}] clipnest web starting" -f (Get-Date -Format "s"))

# Ensure we always serve on the expected fixed port.
$listener = $null
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $WebPort)
  $listener.Start()
} catch {
  $msg = "[{0}] clipnest web cannot start: port {1} is occupied. free this port and restart task." -f (Get-Date -Format "s"), $WebPort
  Write-LogLine $msg
  throw $msg
} finally {
  if ($listener) {
    $listener.Stop()
  }
}

# Vite preview expects the project root as a positional argument, not --root.
& $Node $ViteEntry preview (Join-Path $RepoRoot "apps\\web") --host 127.0.0.1 --port $WebPort --strictPort >> $LogFile 2>&1
