# register-guards.ps1 -- watchdog tasks for the three connectors a server depends on.
# Lesson that motivated this: a live outage came from cloudflared receiving SIGTERM
# (log: "Initiating graceful shutdown due to signal terminated") while the task that
# started it had only a boot trigger -- nothing brought it back for hours.
#
# Health is judged by task state plus observable effect (a listening port, a process), never
# by counting cloudflared processes: a shared machine runs several connectors, and a
# cloudflared login token is not always a decodable JWT (the token-run form rotated to an
# opaque 240-char value), so the older "decode the token and look for your tunnel UUID"
# check silently never matched and the guard became decoration. Ask the scheduler instead.
param(
  [string]$TunnelTask = 'StrongholdTunnel',
  [string]$FrpTask = 'StrongholdFrp',
  [string]$DirectoryTask = 'SpDirectory',
  [int]$DirectoryPort = 8793,
  [string]$UpdateDir = 'D:\stronghold\update',
  [string]$LogPath = 'D:\stronghold\logs\connector-guard.log',
  [int]$EveryMinutes = 5
)
$ErrorActionPreference = 'Continue'
if (-not (Test-Path (Join-Path $UpdateDir 'task_guard.ps1'))) {
  Write-Output ('MISSING ' + $UpdateDir + '\task_guard.ps1 -- copy it next to this script first'); exit 1
}
$g = Join-Path $UpdateDir 'task_guard.ps1'
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$boot = New-ScheduledTaskTrigger -AtStartup
$rep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
# IgnoreNew matters: a guard tick landing while the watched task is still Running must not
# stack a second connector on the same tunnel.
$set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3)

function Add-Guard($name, $args, $desc) {
  $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c ' + $ps + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $g + '" ' + $args)
  Register-ScheduledTask -TaskName $name -Action $act -Trigger @($boot, $rep) -Settings $set -Principal $prin -Description $desc -Force | Out-Null
  $q = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $q) { Write-Output ("FAIL " + $name); return }
  $i = Get-ScheduledTaskInfo -TaskName $name
  Write-Output ($name + '=ok state=' + [string]$q.State + ' next=' + $i.NextRunTime + ' triggers=' + (@($q.Triggers).Count) + ' user=' + $q.Principal.UserId)
}

Add-Guard 'SpConnectorGuard'   ('-Task ' + $TunnelTask + ' -LogPath "' + $LogPath + '"') 'Restart this server''s tunnel connector within one tick if its task leaves Running.'
Add-Guard 'SpFrpGuard'         ('-Task ' + $FrpTask + ' -Proc frpc -LogPath "' + $LogPath + '"') 'Restart the frp connector if frpc is gone.'
Add-Guard 'SpDirectoryGuard'   ('-Task ' + $DirectoryTask + ' -Port ' + $DirectoryPort + ' -LogPath "' + $LogPath + '"') 'Restart the room directory if its port stops listening.'

Write-Output ''
Write-Output ('Watchdogs wake every ' + $EveryMinutes + ' min, at boot, as SYSTEM, windowless. Restart decisions are appended to ' + $LogPath + ' (64 KB cap).')
Write-Output ('Verify by effect: stop a watched task, wait one tick, then check ' + $LogPath + ' and that the port/process came back.')
