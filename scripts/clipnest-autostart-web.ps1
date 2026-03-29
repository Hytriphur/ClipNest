# ClipNest web-only autostart installer (Windows, silent)
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clipnest-autostart-web.ps1

param(
  [string]$TaskName = "ClipNest Web",
  [int]$WebPort = 5173
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ScriptPath = Join-Path $RepoRoot "scripts\\clipnest-run-web.ps1"
$WebEntry = Join-Path $RepoRoot "apps\\web\\dist\\index.html"
if (!(Test-Path $ScriptPath)) {
  throw "Missing script: $ScriptPath"
}
if (!(Test-Path $WebEntry)) {
  throw "Web build missing. Run: npm run build -w apps/web"
}

$startupDir = [Environment]::GetFolderPath("Startup")
$legacy = Join-Path $startupDir "ClipNest Startup.vbs"
if (Test-Path $legacy) {
  Remove-Item -LiteralPath $legacy -Force
  Write-Host "Removed legacy startup entry: $legacy"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" -RepoRoot `"$RepoRoot`" -WebPort $WebPort"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::FromDays(3650))

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "ClipNest web background task" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started task: $TaskName"
Write-Host "Verify: http://localhost:$WebPort"
