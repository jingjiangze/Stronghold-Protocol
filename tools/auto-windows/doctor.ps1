# doctor.ps1 -- is this deployment actually healthy? Run it after install and any time
# players report problems. Prints PASS/FAIL lines and exits non-zero on any FAIL.
param([string]$Config = 'D:\stronghold\update\config.json')
$ErrorActionPreference = 'Continue'
$C = Get-Content $Config -Raw | ConvertFrom-Json
$upd = Split-Path $Config -Parent
$fails = 0
function Chk($name, $ok, $detail) { '{0}  {1,-26} {2}' -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail
  if (-not $ok) { $script:fails++ } }
function Hz($port) { try { (Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json } catch { $null } }
function PortPid($port) { (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

foreach ($p in 'node', 'git', 'npm') { $exe = $C.("$p" + 'Exe'); Chk "bin-$p" (Test-Path $exe) $exe }
Chk 'nginx-exe' (Test-Path (Join-Path $C.nginxDir 'nginx.exe')) $C.nginxDir
foreach ($s in 'A', 'B') { $d = $C.slots.$s.dir; Chk "slot-$s-dir" (Test-Path $d) "$d :$($C.slots.$s.port)" }

$live = (Select-String -Path (Join-Path $C.nginxDir 'conf/sp_current.conf') -Pattern '127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1)
$livePort = if ($live) { [int]$live.Matches[0].Groups[1].Value } else { 0 }
Chk 'flip-knob' ($livePort -ne 0) "sp_current -> :$livePort"
Chk 'active-slot-listening' ([bool](PortPid $livePort)) ":$livePort pid=$(PortPid $livePort)"
$hh = Hz $livePort
Chk 'active-slot-healthz' ($hh -and $hh.ok) $(if ($hh) { "app=$($hh.app) proto=$($hh.version) sockets=$($hh.sockets) matches=$($hh.matches) uptime=$($hh.uptimeSec)" } else { 'no answer' })
$pub = Hz $C.publicPort
Chk 'nginx-front' ($pub -and $pub.ok) $(if ($pub) { "app=$($pub.app) uptime=$($pub.uptimeSec)" } else { 'no answer' })
if ($pub -and $hh) { Chk 'front-matches-slot' ($pub.uptimeSec -le ($hh.uptimeSec + 15)) "front=$($pub.uptimeSec) slot=$($hh.uptimeSec)" }
if ($C.compatPort) { $comp = Hz $C.compatPort
  Chk 'compat-entry' ([bool](PortPid $C.compatPort)) $(if ($comp) { ":$($C.compatPort) app=$($comp.app) (for relays pinned to one port)" } else { ":$($C.compatPort) pid=$(PortPid $C.compatPort)" }) }

# the things that silently break a slot
Chk 'assets-present' (Test-Path (Join-Path $C.slots.A.dir 'public/assets')) 'public/assets (fetched per server, never in git)'
Chk 'vendor-present' (Test-Path (Join-Path $C.slots.A.dir 'public/vendor')) 'public/vendor (npm postinstall builds it)'
Chk 'node_modules' (Test-Path (Join-Path $C.slots.A.dir 'node_modules')) 'slot A node_modules'
Chk 'no-pause-sentinel' (-not (Test-Path (Join-Path $upd 'PAUSE_AUTOUPDATE'))) $(if (Test-Path (Join-Path $upd 'PAUSE_AUTOUPDATE')) { 'auto-update is paused deliberately' } else { 'ok' })
$alerts = @(Get-ChildItem $upd -Filter 'ALERT_*' -ErrorAction SilentlyContinue)
Chk 'no-alerts' ($alerts.Count -eq 0) ($alerts | ForEach-Object { $_.Name } | Out-String).Trim()
$age = if (Test-Path (Join-Path $upd 'state.json')) { ((Get-Date) - (Get-Item (Join-Path $upd 'state.json')).LastWriteTime).TotalHours } else { 9999 }
Chk 'update-is-recent' ($age -lt ([double]$C.pollMinutes * 6 / 60 + 2)) "state.json age=$([math]::Round($age,1))h (poll every $($C.pollMinutes)m)"
foreach ($t in 'SpNginxInstance', 'SpNginx', 'SpServerGuard', 'SpAutoUpdate', 'SpDoctor') {
  $o = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  Chk "task-$t" ([bool]$o) $(if ($o) { $x = Get-ScheduledTaskInfo -TaskName $t; "last=$($x.LastRunTime) rc=$($x.LastTaskResult)" } else { 'not registered' })
}
Write-Output ("RESULT " + $(if ($fails -eq 0) { 'ALL PASS' } else { "$fails FAIL" }))
exit $(if ($fails -eq 0) { 0 } else { 1 })
