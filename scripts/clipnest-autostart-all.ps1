# ClipNest autostart installer (Windows, silent, server + web)
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-all.ps1

param(
  [string]$TaskServer = "ClipNest Server",
  [string]$TaskWeb = "ClipNest Web",
  [string]$TaskLauncher = "ClipNest Launcher",
  [string]$Proxy = "http://127.0.0.1:7890",
  [string]$LogLevel = "info",
  [int]$Port = 5174,
  [int]$WebPort = 5173,
  [int]$LauncherPort = 5180
)

$ErrorActionPreference = "Stop"

function Remove-LegacyStartupEntries([string]$startupDir) {
  $legacyFiles = @(
    (Join-Path $startupDir "ClipNest Startup.cmd"),
    (Join-Path $startupDir "ClipNest Startup.vbs")
  )
  foreach ($f in $legacyFiles) {
    if (Test-Path $f) {
      Remove-Item -LiteralPath $f -Force
      Write-Host "Removed legacy startup entry: $f"
    }
  }
}

function Remove-TaskIfExists([string]$taskName) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed old task: $taskName"
  }
}

function Register-HiddenTask(
  [string]$taskName,
  [string]$scriptPath,
  [string]$scriptArgs
) {
  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" $scriptArgs"

  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgs
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::FromDays(3650))

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "ClipNest background service task" `
    -Force | Out-Null

  Write-Host "Registered task: $taskName"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServerScript = Join-Path $RepoRoot "scripts\\clipnest-run-server.ps1"
$WebScript = Join-Path $RepoRoot "scripts\\clipnest-run-web.ps1"
$LauncherScript = Join-Path $RepoRoot "scripts\\clipnest-run-launcher.ps1"

if (!(Test-Path $ServerScript)) {
  throw "Missing script: $ServerScript"
}
if (!(Test-Path $WebScript)) {
  throw "Missing script: $WebScript"
}
if (!(Test-Path $LauncherScript)) {
  throw "Missing script: $LauncherScript"
}

$ServerEntry = Join-Path $RepoRoot "apps\\server\\dist\\index.js"
$WebEntry = Join-Path $RepoRoot "apps\\web\\dist\\index.html"
if (!(Test-Path $ServerEntry)) {
  throw "Server build missing. Run: npm run build -w apps/server"
}
if (!(Test-Path $WebEntry)) {
  throw "Web build missing. Run: npm run build -w apps/web"
}

$startupDir = [Environment]::GetFolderPath("Startup")
Remove-LegacyStartupEntries -startupDir $startupDir
Remove-TaskIfExists -taskName $TaskServer
Remove-TaskIfExists -taskName $TaskWeb
Remove-TaskIfExists -taskName $TaskLauncher

$serverArgs = "-RepoRoot `"$RepoRoot`" -Proxy `"$Proxy`" -LogLevel `"$LogLevel`" -Port $Port"
$webArgs = "-RepoRoot `"$RepoRoot`" -WebPort $WebPort"
$launcherArgs = "-RepoRoot `"$RepoRoot`" -Port $LauncherPort -ServerUrl `"http://127.0.0.1:$Port`" -WebUrl `"http://127.0.0.1:$WebPort`""

Register-HiddenTask -taskName $TaskServer -scriptPath $ServerScript -scriptArgs $serverArgs
Register-HiddenTask -taskName $TaskWeb -scriptPath $WebScript -scriptArgs $webArgs
Register-HiddenTask -taskName $TaskLauncher -scriptPath $LauncherScript -scriptArgs $launcherArgs

Start-ScheduledTask -TaskName $TaskServer
Start-ScheduledTask -TaskName $TaskWeb
Start-ScheduledTask -TaskName $TaskLauncher

Write-Host ""
Write-Host "Autostart installed and tasks started."
Write-Host "Verify:"
Write-Host "  http://localhost:$Port/api/health"
Write-Host "  http://localhost:$WebPort"
Write-Host "  http://127.0.0.1:$LauncherPort/api/health"
Write-Host ""
Write-Host "Task status:"
Write-Host "  Get-ScheduledTask -TaskName `"$TaskServer`", `"$TaskWeb`", `"$TaskLauncher`" | Select-Object TaskName, State"
