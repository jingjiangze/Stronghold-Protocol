# install.ps1 -- one-time setup for the blue/green Windows deployment.
# Creates the layout, fetches nginx, renders the config from your config.json,
# clones the server, and registers the five scheduled tasks (all windowless, SYSTEM).
param([string]$Config = 'D:\stronghold\update\config.json', [string]$NginxUrl = 'https://nginx.org/download/nginx-1.27.4.zip')
$ErrorActionPreference = 'Continue'
$C = Get-Content $Config -Raw | ConvertFrom-Json
$upd = Split-Path $Config -Parent
function Say($m) { '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), (($m | Out-String).Trim()) }

Say '=== 1. directories ==='
foreach ($d in @($C.baseDir, $upd, (Join-Path $C.baseDir 'logs'), (Join-Path $C.baseDir 'backup'))) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  Say "ok $d"
}

Say '=== 2. prerequisites ==='
foreach ($t in @(@('node', $C.nodeExe), @('npm', $C.npmExe), @('git', $C.gitExe))) {
  if (Test-Path $t[1]) { Say "$($t[0]) -> $($t[1])" } else { Say "MISSING $($t[0]) at $($t[1]) -- install it (node >= 22) and edit config.json" }
}
Say ("node = " + ((& $C.nodeExe -v) | Out-String).Trim())

Say '=== 3. server checkout (code only; game assets are fetched separately per server) ==='
$A = $C.slots.A.dir
if (-not (Test-Path (Join-Path $A '.git'))) {
  if (Test-Path $A) { Say "WARN $A exists but is not a git checkout; leaving it untouched" }
  else { & $C.gitExe clone --quiet --branch $C.trackBranch $C.repoUrl $A 2>&1 | ForEach-Object { Say "git: $_" } }
} else { Say 'slot A already a git checkout' }
Push-Location $A
& $C.gitExe config --local core.autocrlf false | Out-Null
Say ("slot A at " + (& $C.gitExe rev-parse --short HEAD) + " app=" + (([regex]::Match((Get-Content 'shared/constants.js' -Raw), "APP_VERSION\s*=\s*'([^']+)'")).Groups[1].Value))
Pop-Location

Say '=== 4. nginx ==='
if (-not (Test-Path (Join-Path $C.nginxDir 'nginx.exe'))) {
  $zip = Join-Path $upd 'nginx.zip'
  try { Invoke-WebRequest -Uri $NginxUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300 } catch { Say "download failed: $($_.Exception.Message)"; Say 'pass -NginxUrl <mirror> (nginx.org may be unreachable from your network)'; exit 1 }
  if ((Get-Item $zip).Length -lt 500000) { Say 'nginx zip looks truncated'; exit 1 }
  $x = Join-Path $upd 'nginx-x'; if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  New-Item -ItemType Directory -Path $x -Force | Out-Null
  & tar.exe -xf $zip -C $x 2>&1 | ForEach-Object { Say "tar: $_" }
  $inner = Get-ChildItem $x -Directory | Select-Object -First 1
  Move-Item -LiteralPath $inner.FullName -Destination $C.nginxDir -Force
  Remove-Item $zip -ErrorAction SilentlyContinue
  Say ("installed " + ((& (Join-Path $C.nginxDir 'nginx.exe') -v 2>&1) | Out-String).Trim())
} else { Say 'nginx already present' }

Say '=== 5. render config from template ==='
$tplPath = Join-Path $PSScriptRoot 'nginx.conf.template'
$tpl = [IO.File]::ReadAllText($tplPath)
$pubRoot = (Join-Path $A 'public') -replace '\\', '/'
$audioRoot = (Join-Path $A 'public/assets/audio') -replace '\\', '/'
$tpl = $tpl.Replace('__PUBLIC_PORT__', "$($C.publicPort)").Replace('__COMPAT_PORT__', "$($C.compatPort)")
$tpl = $tpl.Replace('__SERVER_NAME__', $C.hostname).Replace('__PUBLIC_ROOT__', $pubRoot).Replace('__AUDIO_ROOT__', $audioRoot)
[IO.File]::WriteAllText((Join-Path $C.nginxDir 'conf/nginx.conf'), $tpl, (New-Object System.Text.UTF8Encoding($false)))
$slotF = Join-Path $C.nginxDir 'conf/sp_current.conf'
if (-not (Test-Path $slotF)) { [IO.File]::WriteAllText($slotF, "upstream sp_current {`n    server 127.0.0.1:$($C.slots.A.port);`n    keepalive 48;`n}`n") }
Say 'wrote conf/nginx.conf + conf/sp_current.conf (the single flip knob)'

Say '=== 6. slots file ==='
$slotsJson = "{`"A`":{`"dir`":`"$($C.slots.A.dir.Replace('\','/'))`",`"port`":$($C.slots.A.port)},`"B`":{`"dir`":`"$($C.slots.B.dir.Replace('\','/'))`",`"port`":$($C.slots.B.port)}}"
[IO.File]::WriteAllText((Join-Path $upd 'sp_slots.json'), $slotsJson, (New-Object System.Text.ASCIIEncoding))
[IO.File]::WriteAllText((Join-Path $upd 'active_slot.json'), "{`"active`":`"A`",`"port`":$($C.slots.A.port)}", (New-Object System.Text.ASCIIEncoding))
Say 'sp_slots.json + active_slot.json written (forward slashes: backslashes break JSON parsing)'

Say '=== 7. scheduled tasks ==='
$prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$boot = New-ScheduledTaskTrigger -AtStartup
$set0 = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$run = { param($name, $file, $log, $intervalMin, $ttlMin)
  $rep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $intervalMin) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes $ttlMin)
  $a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$file`" >> `"$log`" 2>&1"
  Register-ScheduledTask -TaskName $name -Action $a -Trigger @($boot, $rep) -Settings $set -Principal $prin -Description $name | Out-Null
  Say "$name every ${intervalMin}m -> " + [bool](Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
}
& $run 'SpNginx' (Join-Path $PSScriptRoot 'nginx_keep.ps1') (Join-Path $C.baseDir 'logs\nginx.log') 5 0
& $run 'SpServerGuard' (Join-Path $PSScriptRoot 'ensure_server.ps1') (Join-Path $C.baseDir 'logs\guard.log') 5 4
& $run 'SpAutoUpdate' (Join-Path $PSScriptRoot 'sp_update.ps1') (Join-Path $C.baseDir 'logs\autoupdate.log') $C.pollMinutes 50
& $run 'SpDoctor' (Join-Path $PSScriptRoot 'doctor.ps1') (Join-Path $C.baseDir 'logs\doctor.log') 30 5
# the nginx instance itself is long-lived: run it in the foreground so the task == the process
$nxAct = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$($C.nginxDir)\nginx.exe`" -p $($C.nginxDir.Replace('\','/'))/ -c conf/nginx.conf >> `"$($C.baseDir)\logs\nginx-stdout.log`" 2>&1"
Register-ScheduledTask -TaskName 'SpNginxInstance' -Action $nxAct -Trigger $boot -Settings $set0 -Principal $prin -Description 'nginx front for the game server (foreground instance)' -Force | Out-Null
Say 'SpNginxInstance registered'

Say '=== 8. first run ==='
& schtasks.exe /Run /TN 'SpNginxInstance' | Out-Null
Start-Sleep -Seconds 4
& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure_server.ps1') -Config $Config 2>&1 | ForEach-Object { Say "ensure: $_" }
Start-Sleep -Seconds 6
& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'doctor.ps1') -Config $Config 2>&1 | ForEach-Object { Say "doctor: $_" }
