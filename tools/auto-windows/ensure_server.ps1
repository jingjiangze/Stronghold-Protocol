# ensure_server.ps1 -- keep whichever slot nginx points at alive.
# Runs at boot and every 5 minutes. Never force-kills a busy slot: uptime alone says
# nothing about whether players are still on it.
param([string]$Config = 'D:\stronghold\update\config.json')
$ErrorActionPreference = 'Continue'
$upd = Split-Path $Config -Parent
if (Test-Path (Join-Path $upd '.lock')) { exit 0 }   # an update run owns the slots right now
$C = Get-Content $Config -Raw | ConvertFrom-Json
function Hz($port) { try { (Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 6).Content | ConvertFrom-Json } catch { $null } }
function PortPid($port) { (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Start-Slot($slot) {
  $cmd = @"
@echo off
cd /d $($slot.dir)
set HOST=127.0.0.1
set PORT=$($slot.port)
set TRUST_PROXY=1
set SP_NO_BROWSER=1
"$($C.nodeExe)" $($C.entryScript) >> $(Join-Path $C.baseDir 'logs')\server-$($slot.port).log 2>&1
"@
  $f = Join-Path $upd "slot_$($slot.port).cmd"
  if (-not (Test-Path $f)) { [IO.File]::WriteAllText($f, $cmd, (New-Object Text.ASCIIEncoding)) }
  Start-Process -FilePath $f -WindowStyle Hidden | Out-Null
}
$cur = $C.slots.A; $idle = $C.slots.B
$confLine = (Select-String -Path (Join-Path $C.nginxDir 'conf/sp_current.conf') -Pattern '127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1)
$livePort = if ($confLine) { [int]$confLine.Matches[0].Groups[1].Value } else { [int]$C.slots.A.port }
if ($livePort -eq [int]$C.slots.B.port) { $cur = $C.slots.B; $idle = $C.slots.A }

if (-not (PortPid $cur.port)) {
  Write-Output ("{0} active slot :{1} not listening -> starting" -f (Get-Date -Format 's'), $cur.port)
  if (Test-Path $cur.dir) { Start-Slot $cur; Start-Sleep -Seconds 6
    $h = Hz $cur.port; Write-Output ("  after start: " + $(if ($h) { "app=$($h.app) uptime=$($h.uptimeSec)" } else { 'still down' })) }
  else { Write-Output "  slot dir missing: $($cur.dir)" }
}
$ip = PortPid $idle.port
if ($ip) {
  $ih = Hz $idle.port
  if ($ih -and [int]$ih.sockets -eq 0 -and [int]$ih.matches -eq 0) {
    Write-Output ("{0} idle slot :{1} empty -> reaping" -f (Get-Date -Format 's'), $idle.port)
    Stop-Process -Id $ip -Force -ErrorAction SilentlyContinue
  } elseif ($ih) {
    Write-Output ("{0} idle slot :{1} still busy sockets={2} matches={3} -> left alone" -f (Get-Date -Format 's'), $idle.port, $ih.sockets, $ih.matches)
  }
}
