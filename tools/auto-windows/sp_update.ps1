# sp_update.ps1 -- blue/green auto-update for a Windows Stronghold server.
# Poll upstream, stage the idle slot, prove it healthy, flip one nginx upstream line,
# then drain the old slot. Config-driven; no credentials and no game assets here.
param([string]$Config = 'D:\stronghold\update\config.json')
$ErrorActionPreference = 'Continue'
$C = Get-Content $Config -Raw | ConvertFrom-Json
$upd = Split-Path $Config -Parent
$logDir = Join-Path $C.baseDir 'logs'
$bkRoot = Join-Path $C.baseDir 'backup'
$state = Join-Path $upd 'state.json'
$active = Join-Path $upd 'active_slot.json'
$slotFile = Join-Path $upd 'sp_slots.json'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$git = $C.gitExe

function Say($m) { '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (($m | Out-String).Trim()) }
function VerKey($t) { $n = ($t -replace '^v', ''); $p = $n.Split('.'); $a = 0; $b = 0; $c = 0
  if ($p.Count -ge 1) { [void][int]::TryParse($p[0], [ref]$a) }
  if ($p.Count -ge 2) { [void][int]::TryParse($p[1], [ref]$b) }
  if ($p.Count -ge 3) { [void][int]::TryParse($p[2], [ref]$c) }
  return ($a * 1000000 + $b * 1000 + $c) }
function ConstOf($dir, $name) { $p = Join-Path $dir 'shared/constants.js'
  if (-not (Test-Path $p)) { return '' }
  $m = [regex]::Match((Get-Content $p -Raw), "$name\s*=\s*'?([^'\s;]+)'?"); if ($m.Success) { $m.Groups[1].Value } else { '' } }
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
"$($C.nodeExe)" $($C.entryScript) >> $logDir\server-$($slot.port).log 2>&1
"@
  $f = Join-Path $upd "slot_$($slot.port).cmd"
  [IO.File]::WriteAllText($f, $cmd, (New-Object Text.ASCIIEncoding))
  Start-Process -FilePath $f -WindowStyle Hidden | Out-Null
}
function Write-SlotFile($o) { ($o | ConvertTo-Json) | Set-Content -LiteralPath $active -Encoding ASCII }

Say '=== sp_update start ==='
$lock = Join-Path $upd '.lock'
if (Test-Path $lock) { $age = ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes
  if ($age -lt 90) { Say "another run active ($([math]::Round($age)) min) -> exit"; exit 0 }
  Say 'stale lock, taking over' }
'' | Set-Content -LiteralPath $lock -Encoding ASCII
try {
  if (Test-Path (Join-Path $upd 'PAUSE_AUTOUPDATE')) { Say 'PAUSE_AUTOUPDATE present -> nothing done'; exit 0 }
  $force = Test-Path (Join-Path $upd 'FORCE')
  $stageOnly = Test-Path (Join-Path $upd 'STAGE_ONLY')
  $slots = Get-Content $slotFile -Raw | ConvertFrom-Json
  $actName = (Get-Content $active -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json).active
  if (-not $actName) { $l = (Select-String -Path (Join-Path $C.nginxDir 'conf/sp_current.conf') -Pattern '127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1)
    $actName = if ($l -and [int]$l.Matches[0].Groups[1].Value -eq $C.slots.B.port) { 'B' } else { 'A' } }
  $cur = if ($actName -eq 'B') { $C.slots.B } else { $C.slots.A }
  $idle = if ($actName -eq 'B') { $C.slots.A } else { $C.slots.B }
  $idleName = if ($actName -eq 'B') { 'A' } else { 'B' }
  Say "active=$actName(:$($cur.port)) idle=$idleName(:$($idle.port)) force=$force stageOnly=$stageOnly"

  # ---- upstream head + newest release tag, via git (no rate limit) ----
  $head = ''; $tag = ''
  for ($i = 1; $i -le 3 -and -not $head; $i++) {
    $o = (& $git ls-remote $C.repoUrl "refs/heads/$($C.trackBranch)" 2>&1) | Out-String
    if ($LASTEXITCODE -eq 0) { $m = [regex]::Match($o, "([0-9a-f]{40})\s+refs/heads/$([regex]::Escape($C.trackBranch))"); if ($m.Success) { $head = $m.Groups[1].Value } }
    else { Say "ls-remote attempt $i failed"; Start-Sleep -Seconds (5 * $i) }
  }
  if (-not $head) { Say 'upstream unreachable -> retry next cycle'; exit 0 }
  if ($C.tagWatch) {
    $t = ((& $git ls-remote $C.repoUrl 'refs/tags/v*' 2>&1) | Out-String)
    $names = @(); foreach ($line in ($t -split "`n")) { $m = [regex]::Match($line.Trim(), 'refs/tags/(v[0-9]+(?:\.[0-9]+)*)'); if ($m.Success) { $names += $m.Groups[1].Value } }
    if ($names.Count) { $tag = ($names | Sort-Object { VerKey $_ } | Select-Object -Last 1) }
  }
  Say "upstream $($C.trackBranch)=$($head.Substring(0,8)) newestTag=$tag running app=$(ConstOf $cur.dir 'APP_VERSION')"
  $curSha = (& $git -C $cur.dir rev-parse --verify -q HEAD 2>$null)
  if ($curSha -eq $head -and -not $force) { Say 'already current -> nothing to do'; exit 0 }

  # ---- fetch once (both slots share the object store) ----
  Push-Location $C.slots.A.dir
  (& $git fetch -q --depth 1 --force $C.repoUrl $C.trackBranch 2>&1) | ForEach-Object { Say "fetch: $_" }
  if ($LASTEXITCODE -ne 0) { Say 'fetch failed -> retry next cycle'; Pop-Location; exit 0 }
  $newSha = (& $git rev-parse FETCH_HEAD)

  # ---- gate 1: only server-relevant paths may restart a live server ----
  if ($curSha -and -not $force) {
    & $git diff --quiet $curSha $newSha -- $C.serverPaths 2>$null
    if ($LASTEXITCODE -eq 0) { Say 'no change under server paths -> recording head, no restart'
      [ordered]@{ sha = $newSha; tag = $tag; recordedAt = (Get-Date).ToString('s'); headOnly = $true } | ConvertTo-Json | Set-Content $state -Encoding ASCII
      Pop-Location; exit 0 }
    Say 'server-relevant files changed -> proceeding'
  }

  # ---- read the incoming version BEFORE any refusal logic ----
  $tmp = Join-Path $env:TEMP 'sp_incoming_constants.js'
  (& $git show "${newSha}:shared/constants.js") > $tmp 2>$null
  $tc = Get-Content $tmp -Raw -ErrorAction SilentlyContinue
  $newApp = ([regex]::Match($tc, "APP_VERSION\s*=\s*'([^']+)'")).Groups[1].Value
  $newProto = ([regex]::Match($tc, 'PROTOCOL_VERSION\s*=\s*([0-9]+)')).Groups[1].Value
  $curProto = ConstOf $cur.dir 'PROTOCOL_VERSION'
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Say "incoming APP_VERSION=$newApp PROTOCOL_VERSION=$newProto (running proto=$curProto)"

  # ---- gate 2: never move backwards ----
  if ((VerKey "v$newApp") -lt (VerKey ('v' + (ConstOf $cur.dir 'APP_VERSION')))) { Say 'REFUSING downgrade'; exit 0 }
  if ($curSha) { & $git merge-base --is-ancestor $newSha $curSha 2>$null
    if ($LASTEXITCODE -eq 0 -and $newSha -ne $curSha) { Say 'REFUSING: incoming is an ancestor of the running commit'; exit 0 } }

  # ---- gate 3: a wire-version change cannot be solved by blue/green ----
  if ($newProto -and $curProto -and ($newProto -ne $curProto)) {
    [ordered]@{ at = (Get-Date).ToString('s'); reason = 'PROTOCOL_VERSION change'; from = $curProto; to = $newProto; sha = $newSha; app = $newApp } |
      ConvertTo-Json | Set-Content (Join-Path $upd 'ALERT_PROTOCOL_CHANGE.json') -Encoding ASCII
    New-Item -ItemType File -Path (Join-Path $upd 'PAUSE_AUTOUPDATE') -Force | Out-Null
    Say 'protocol change -> auto-update paused, operator decision required'; Pop-Location; exit 0
  }

  # ---- stage the idle slot ----
  if (-not (Test-Path $idle.dir)) { (& $git worktree add -q --detach $idle.dir $newSha 2>&1) | ForEach-Object { Say "wt: $_" }
    if ($LASTEXITCODE -ne 0) { Say 'worktree add failed'; Pop-Location; exit 1 } }
  else { (& $git -C $idle.dir reset -q --hard $newSha 2>&1) | ForEach-Object { Say "reset: $_" } }
  Pop-Location
  Say "idle slot at $((& $git -C $idle.dir rev-parse --short HEAD)) app=$(ConstOf $idle.dir 'APP_VERSION')"

  # ---- share heavy gitignored material instead of copying it per slot ----
  foreach ($rel in $C.shareAcrossSlots) {
    $link = Join-Path $idle.dir ($rel -replace '/', '\')
    $target = Join-Path $C.slots.A.dir ($rel -replace '/', '\')
    if (-not (Test-Path $target)) { Say "warn: no $target to share"; continue }
    if (Test-Path $link) { Say "kept existing $rel in idle slot" }
    else { New-Item -ItemType Junction -Path $link -Target $target -ErrorAction SilentlyContinue | Out-Null; Say "junction $rel -> slot A" }
  }
  foreach ($rel in $C.keepUntracked) {
    $src = Join-Path $cur.dir ($rel -replace '/', '\'); $dst = Join-Path $idle.dir ($rel -replace '/', '\')
    if ((Test-Path $src) -and -not (Test-Path $dst)) {
      if (Test-Path $src -PathType Container) { Copy-Item -Recurse -Force $src $dst } else { Copy-Item -Force $src $dst }
      Say "carried operator file forward: $rel" }
  }

  # ---- dependencies only when the lockfile changed ----
  $hA = (Get-FileHash (Join-Path $C.slots.A.dir 'package-lock.json') -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
  $hB = (Get-FileHash (Join-Path $idle.dir 'package-lock.json') -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
  Push-Location $idle.dir
  if ($hA -eq $hB -and (Test-Path 'node_modules')) { Say 'lockfile unchanged and node_modules present -> skipping npm install' }
  else { Say 'npm install'
    (& $C.npmExe install --no-audit --no-fund --loglevel=error 2>&1) | ForEach-Object { Say "npm: $_" }
    if ($LASTEXITCODE -ne 0) { Say "npm retry via $($C.npmFallbackRegistry)"
      (& $C.npmExe install --no-audit --no-fund --loglevel=error --registry=$($C.npmFallbackRegistry) 2>&1) | ForEach-Object { Say "npm: $_" } } }
  Pop-Location

  # ---- the idle slot must prove itself on its own port before it can see players ----
  $stale = PortPid $idle.port
  if ($stale) { Stop-Process -Id $stale -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
  Start-Slot $idle
  $h = $null; $up = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 2; $h = Hz $idle.port; if ($h -and $h.ok) { $up = $true; break } }
  Say "idle slot healthy=$up app=$($h.app) proto=$($h.version)"
  if (-not $up) { $p = PortPid $idle.port; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    [ordered]@{ at = (Get-Date).ToString('s'); sha = $newSha; reason = 'staged slot failed to start' } | ConvertTo-Json | Set-Content (Join-Path $upd 'ALERT_STAGE_FAILED.json') -Encoding ASCII
    exit 2 }
  if ($stageOnly) { $p = PortPid $idle.port; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Say 'STAGE_ONLY -> rehearsal finished, no flip'; exit 0 }

  # ---- flip: one line + reload. Sockets opened before the reload keep running on the old worker ----
  $conf = Join-Path $C.nginxDir 'conf/sp_current.conf'
  [IO.File]::WriteAllText($conf, "upstream sp_current {`n    server 127.0.0.1:$($idle.port);`n    keepalive 48;`n}`n")
  $nginxExe = Join-Path $C.nginxDir 'nginx.exe'
  (& $nginxExe -p ($C.nginxDir + '\') -c 'conf/nginx.conf' -t 2>&1) | Out-Null
  if ($LASTEXITCODE -ne 0) { [IO.File]::WriteAllText($conf, "upstream sp_current {`n    server 127.0.0.1:$($cur.port);`n    keepalive 48;`n}`n")
    Say 'nginx config invalid -> flip reverted'; $p = PortPid $idle.port; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; exit 3 }
  (& (Join-Path $C.nginxDir 'nginx.exe') -p ($C.nginxDir + '\') -c 'conf/nginx.conf' -s reload 2>&1) | ForEach-Object { Say "reload: $_" }
  Start-Sleep -Seconds 4
  $via = Hz $C.publicPort
  Say "through nginx: app=$($via.app) uptime=$($via.uptimeSec)"
  if (-not $via -or $via.uptimeSec -gt ($h.uptimeSec + 25)) {
    [IO.File]::WriteAllText($conf, "upstream sp_current {`n    server 127.0.0.1:$($cur.port);`n    keepalive 48;`n}`n")
    (& (Join-Path $C.nginxDir 'nginx.exe') -p ($C.nginxDir + '\') -c 'conf/nginx.conf' -s reload 2>&1) | Out-Null
    Say 'flip did not take effect -> reverted'; exit 4
  }
  Write-SlotFile ([ordered]@{ active = $idleName; port = $idle.port; dir = $idle.dir; sha = $newSha; app = $newApp; proto = $h.version; flippedAt = (Get-Date).ToString('s'); drainingSlot = $actName; drainingPort = $cur.port })

  # ---- drain: retire the old slot only once it is empty (TTL bounds the split window) ----
  $ttl = [int]$C.drainTtlMinutes
  Say "flipped $actName -> $idleName ; draining :$($cur.port) (ttl ${ttl}m)"
  $deadline = (Get-Date).AddMinutes($ttl); $streak = 0
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 20
    $o = Hz $cur.port
    if (-not $o) { Say 'old slot gone -> retired'; break }
    if ([int]$o.sockets -eq 0) { $streak++ } else { $streak = 0 }
    Say "old slot sockets=$($o.sockets) sessions=$($o.sessions) matches=$($o.matches) streak=$streak"
    if ($streak -ge 3) { Say 'old slot empty for a minute -> retiring'; break }
  }
  $op = PortPid $cur.port
  if ($op) { Say "stopping old slot pid $op"; Stop-Process -Id $op -Force -ErrorAction SilentlyContinue }

  [ordered]@{ branch = $C.trackBranch; sha = $newSha; app = $newApp; proto = $h.version; activeSlot = $idleName; port = $idle.port; tag = $tag; updatedAt = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content $state -Encoding ASCII
  if ($force) { Remove-Item (Join-Path $upd 'FORCE') -Force -ErrorAction SilentlyContinue }
  # keep the last 10 code backups only
  Get-ChildItem $bkRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'code-*' } |
    Sort-Object Name -Descending | Select-Object -Skip 10 | ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  Say '=== sp_update done ==='
} catch { Say "UNHANDLED: $($_.Exception.Message)"; exit 1 } finally { Remove-Item $lock -ErrorAction SilentlyContinue }
