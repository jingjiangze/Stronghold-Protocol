# tools/box/sp_update_zip.ps1 -- keep this box on the newest deployment package of OUR release (not upstream's).
#
# THIS FILE IS THE SOURCE OF TRUTH. It ships inside every release package, and a successful deploy copies it (and
# its .cmd) into D:\stronghold\update\ so the scheduled task keeps running the versioned copy instead of an orphan
# edited in place on the box. Never hand-edit the box's copy.
#
# Source: the rolling GitHub release `server-cdn-latest` on jingjiangze/Stronghold-Protocol, asset
# `Stronghold-Protocol-v<version>-cdn.zip` (the no-art build: art comes from weishucdn via SP_ASSET_CDN), mirrored
# to the CDN as deploy/latest.json + deploy/stronghold-server-latest.zip, which this box prefers because GitHub
# asset downloads from it measured 0 bytes in 20 s. No URL is hard-coded: the asset name carries the version.
#
# Deployment reuses the box's blue/green slots: unpack into the IDLE slot's own directory, start it, flip nginx
# (3000 -> the idle port), then the old slot drains (ensure_server2.ps1 reaps it once it is empty). Nothing touches
# the slot players are on, and every failure rolls back to the port that was live.
#
#   powershell -File sp_update_zip.ps1 -Check     # resolve + compare only, change nothing (exit 2 = a deploy is due)
#   powershell -File sp_update_zip.ps1 -DryRun    # download + unpack + contract check, never start or flip
#   powershell -File sp_update_zip.ps1            # deploy when the release moved
#
# Runs as SYSTEM (scheduled task): nginx runs as a service, and an interactive session cannot reload it
# (OpenEvent Global\ngx_reload_<pid> -> Access denied).
param(
  [switch]$Check,
  [switch]$DryRun,
  [switch]$Force,
  [string]$Repo = 'jingjiangze/Stronghold-Protocol',
  [string]$Tag = 'server-cdn-latest',
  [string]$Cdn = 'https://weishucdn.jiangjiangze.icu/'
)
$ErrorActionPreference = 'Continue'
$upd = 'D:\stronghold\update'
$logs = 'D:\stronghold\logs'
$nx = 'D:\stronghold\nginx'
$lockf = "$upd\.lock"
$statef = "$upd\deployed.json"
$stage = "$upd\staging"
function Say($m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (($m | Out-String).Trim())
  Write-Output $line
  # a scheduled task's stdout goes nowhere: keep a bounded log next to the other box logs
  try {
    $lf = "$logs\update-zip.log"
    if ((Test-Path $lf) -and (Get-Item $lf).Length -gt 262144) { (Get-Content $lf -Tail 400) | Set-Content -LiteralPath $lf -Encoding ASCII }
    Add-Content -LiteralPath $lf -Value $line -Encoding ASCII
  } catch { }
}

# ---- http probes: curl, never Invoke-WebRequest (that one goes through the system proxy and lies) --------------
function HttpText($port, $path, [switch]$Head) {
  $cargs = @('--noproxy', '*', '-s', '--max-time', '10')
  if ($Head) { $cargs += '-I' }
  $cargs += ("http://127.0.0.1:{0}{1}" -f $port, $path)
  return ((& curl.exe @cargs 2>$null) | Out-String)
}
function Hz($port) {
  $t = HttpText $port '/healthz'
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}
function CacheControl($port, $path) {
  $t = HttpText $port $path -Head
  if (-not $t) { return $null }
  $m = [regex]'Cache-Control:\s*(?<c>[^\r\n]+)'
  if ($m.IsMatch($t)) { return $m.Match($t).Groups['c'].Value.Trim() }
  return ''
}

# ---- the served-runtime contract (the bandwidth doc, section 9) ---------------------------------
# A deploy that breaks this must not become live: the module graph and /data carry ?v=<build>, the third-party
# tree never does (two URLs for one module = two instances), versioned URLs are immutable and unversioned ones
# are not. Returns the list of failures (empty = good).
function Check-Contract($port, $tag) {
  $fail = @()
  if (-not $tag) { return @('the server reports no build tag') }
  $js = HttpText $port '/js/main.js'
  if (-not $js) { $fail += 'no /js/main.js' }
  else {
    if ($js -notmatch [regex]::Escape("?v=$tag")) { $fail += "/js/main.js carries no ?v=$tag import" }
    if ($js -match 'vendor/[^'']+\?v=') { $fail += '/js/main.js stamps a /vendor/ URL (two instances)' }
  }
  $html = HttpText $port '/'
  if ($html -and ($html -notmatch [regex]::Escape("?v=$tag"))) { $fail += 'index.html does not reference the served build tag' }
  $share = HttpText $port '/shared/constants.js'
  if ($share -and ($share -notmatch [regex]::Escape("?v=$tag"))) { $fail += '/shared/ is not stamped' }
  $imm = CacheControl $port "/js/main.js?v=$tag"
  if ($imm -notmatch 'immutable') { $fail += 'a versioned module is not immutable' }
  $noimm = CacheControl $port '/js/main.js'
  if ($noimm -match 'immutable') { $fail += 'an unversioned module is immutable' }
  $data = CacheControl $port "/data/chess.json?v=$tag"
  if ($data -notmatch 'immutable') { $fail += 'versioned /data is not immutable' }
  return $fail
}

# ---- 0. one updater at a time (the same lock sp_update2.ps1 uses) --------------------------------
if (Test-Path $lockf) {
  $age = ((Get-Date) - (Get-Item $lockf).LastWriteTime).TotalMinutes
  if ($age -lt 90) { Say ("another update is running (lock age $([math]::Round($age)) min) -> exit"); exit 0 }
  Say 'stale lock, taking over'
}
'' | Set-Content -LiteralPath $lockf -Encoding ASCII
try {

# ---- 1. what does our release have? -------------------------------------------------------------
# BOTH sources are read every cycle and the NEWEST wins. Preference alone would stall the box: the CI workflow
# (release-cdn) publishes the GitHub release on every push, while the CDN mirror is refreshed out of band (CI has no
# Cloudflare secrets) and was measured 35 minutes behind at one point -- with a stale manifest the box reads an old
# stamp, decides it is already deployed, and never moves. The other source stays as the download fallback.
$cdnPlan = $null
$ghPlan = $null
$cdnAt = $null
$ghAt = $null
try {
  $meta = Invoke-RestMethod -Uri "$Cdn`deploy/latest.json" -TimeoutSec 30
  if ($meta -and $meta.size -gt 0 -and $meta.sha256) {
    $cdnAt = [datetime]$meta.updatedAt
    $cdnPlan = [ordered]@{ kind = 'cdn'; version = "$($meta.version)"; name = "v$($meta.version)"; url = "$Cdn`deploy/stronghold-server-latest.zip"
      size = [int64]$meta.size; sha256 = "$($meta.sha256)"; at = $cdnAt
      stamp = "cdn|$($meta.version)|$($meta.size)|$($meta.sha256)" }
  }
} catch { Say ("cdn manifest unreachable: " + $_.Exception.Message) }
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers @{ 'User-Agent' = 'stronghold-box-updater'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 40
  # the rolling release accumulates one asset per version (--clobber only replaces the same name): take the NEWEST
  $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Sort-Object { [datetime]$_.updated_at } -Descending | Select-Object -First 1
  if ($asset) {
    $ghAt = [datetime]$asset.updated_at
    $ghPlan = [ordered]@{ kind = 'github'; version = (if ($asset.name -match 'v([0-9][^/]*)-cdn\.zip$') { $matches[1] } else { $asset.name })
      name = $asset.name; url = $asset.browser_download_url; size = [int64]$asset.size; sha256 = $null; at = $ghAt
      stamp = "$($asset.name)|$($asset.updated_at)|$($asset.size)" }
  }
} catch { Say ("release unreachable: " + $_.Exception.Message) }
$plan = $null; $alt = $null
if ($cdnPlan -and $ghPlan) {
  if ($ghAt -gt $cdnAt) { $plan = $ghPlan; $alt = $cdnPlan } else { $plan = $cdnPlan; $alt = $ghPlan }
  Say ("sources: github $($ghAt.ToString('HH:mm:ss')) vs cdn $($cdnAt.ToString('HH:mm:ss')) -> taking $($plan.kind)")
} elseif ($cdnPlan) { $plan = $cdnPlan } elseif ($ghPlan) { $plan = $ghPlan }
if (-not $plan) { Say 'no package source reachable this cycle -> nothing done'; exit 0 }
$version = $plan.version
$stamp = $plan.stamp
Say ("package: $($plan.name) via $($plan.kind) ($([math]::Round($plan.size/1MB,1)) MB)")

# ---- 2. already deployed? -----------------------------------------------------------------------
$deployed = $null
if (Test-Path $statef) { try { $deployed = Get-Content $statef -Raw | ConvertFrom-Json } catch { $deployed = $null } }
if ($deployed -and $deployed.stamp -eq $stamp -and -not $Force) { Say 'already on this package -> nothing done'; exit 0 }
if ($Check) { Say ("CHECK: would deploy $version (deployed: " + $(if ($deployed) { $deployed.version } else { 'unknown' }) + ")"); exit 2 }

# ---- 3. which slot is live, which is idle -------------------------------------------------------
$slots = Get-Content "$upd\sp_slots.json" -Raw | ConvertFrom-Json
$activeName = (Get-Content "$upd\active_slot.json" -Raw | ConvertFrom-Json).active
if ($activeName -ne 'A' -and $activeName -ne 'B') { $activeName = 'A' }
$idleName = if ($activeName -eq 'A') { 'B' } else { 'A' }
$cur = $slots.slots.$activeName
$idle = $slots.slots.$idleName
Say ("live slot $activeName :$($cur.port) dir=$($cur.dir) ; idle $idleName :$($idle.port) dir=$($idle.dir)")

# The two slots must own separate directories, or a flip is a no-op. The first run moves the idle slot onto its own.
if ($idle.dir -eq $cur.dir) {
  $idleDir = ($cur.dir.TrimEnd('/')) + '-' + $idleName.ToLower()
  Say ("idle slot shares the live directory -> giving it $idleDir")
  $slots.slots.$idleName.dir = $idleDir
  ($slots | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath "$upd\sp_slots.json" -Encoding ASCII
  $idle = $slots.slots.$idleName
}
$idleDir = $idle.dir.TrimEnd('/')
$newDir = "$idleDir.new"

function PortPid($port) { (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function WriteSlotCmd($slot) {
  $body = @"
@echo off
rem $($slot.dir) -- the no-art build: public\assets and public\fonts are NOT shipped, the art manifests leave with
rem absolute CDN URLs and /assets//fonts/ redirect there (SP_ASSET_CDN). Written by sp_update_zip.ps1 -- keep the
rem SP_ASSET_CDN line: without it the server serves local art it does not have.
cd /d $($slot.dir)
set HOST=127.0.0.1
set PORT=$($slot.port)
set TRUST_PROXY=1
set SP_NO_BROWSER=1
set SP_ASSET_CDN=$Cdn
set SERVER_TOKEN=%SP_SERVER_TOKEN%
for /f "usebackq tokens=1,2 delims==" %%A in ("D:\stronghold\directory\server-token.txt") do set SERVER_TOKEN=%%A
"C:\Program Files\nodejs\node.exe" server\index.js >> D:\stronghold\logs\server-$($slot.port).log 2>&1
"@
  [IO.File]::WriteAllText("$upd\sp_slot_$($slot.port).cmd", $body, (New-Object Text.ASCIIEncoding))
}

# ---- 4. download (resumable; a staged copy of the same asset is reused) -------------------------
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$zip = "$stage\pkg.zip"
$stagedf = "$stage\staged.json"
$staged = $null
if (Test-Path $stagedf) { try { $staged = Get-Content $stagedf -Raw | ConvertFrom-Json } catch { $staged = $null } }
$haveStaged = $staged -and $staged.asset -eq $plan.name -and $staged.size -eq $plan.size -and (Test-Path $zip) -and (Get-Item $zip).Length -eq $plan.size
if ($haveStaged) { Say "reusing the staged copy of $($plan.name)" }
else {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Say "downloading $($plan.url)"
  & curl.exe -s -L --retry 3 --retry-delay 5 -C - -o $zip $plan.url
}
if ((-not (Test-Path $zip) -or (Get-Item $zip).Length -ne $plan.size) -and $alt) {
  # the two sources do not produce identical bytes (the zip is not reproducible), so a half-download of one cannot be
  # resumed from the other: start over from the fallback and drop its sha (only the CDN manifest carries one).
  Say ("download from $($plan.kind) incomplete -> trying $($alt.kind)")
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  & curl.exe -s -L --retry 3 --retry-delay 5 -C - -o $zip $alt.url
  if ((Test-Path $zip) -and (Get-Item $zip).Length -eq $alt.size) {
    Say ("fell back to $($alt.kind), using its stamp")
    $plan = $alt; $alt = $null
    $version = $plan.version; $stamp = $plan.stamp
  }
}
if (-not (Test-Path $zip) -or (Get-Item $zip).Length -ne $plan.size) {
  Say ("download incomplete (" + $(if (Test-Path $zip) { (Get-Item $zip).Length } else { 0 }) + " of $($plan.size)) -> nothing done")
  exit 0
}
if ($plan.sha256) {
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $plan.sha256.ToLower()) { Say "sha256 mismatch ($got) -> nothing done"; Remove-Item $zip -Force; exit 1 }
  Say 'sha256 verified'
}
[ordered]@{ asset = $plan.name; size = $plan.size } | ConvertTo-Json | Set-Content -LiteralPath $stagedf -Encoding ASCII

# ---- 5. unpack into a fresh directory, then swap it in ------------------------------------------
Remove-Item $newDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $newDir | Out-Null
$inner = "$stage\unpack"
Remove-Item $inner -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $inner | Out-Null
& tar.exe -xf $zip -C $inner
if ($LASTEXITCODE -ne 0) { Say 'unpack failed -> nothing done'; exit 1 }
$root = (Get-ChildItem $inner -Directory | Select-Object -First 1).FullName
if (-not (Test-Path "$root\server\index.js") -or -not (Test-Path "$root\data\assets.json")) { Say "unpacked tree looks wrong ($root) -> nothing done"; exit 1 }
Copy-Item "$root\*" $newDir -Recurse -Force
# node_modules is 120 MB and identical between releases: borrow the live slot's copy when the zip has none
if (-not (Test-Path "$newDir\node_modules") -and (Test-Path "$cur.dir\node_modules")) {
  Say 'zip has no node_modules -> copying the live slot''s'
  & robocopy "$($cur.dir.TrimEnd('/'))\node_modules" "$newDir\node_modules" /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
if ($DryRun) {
  Say 'DRYRUN: staged and unpacked the package; nothing started, nginx untouched'
  Say ("DRYRUN: the tree is at $newDir (" + [math]::Round(((Get-ChildItem $newDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1) + " MB)")
  exit 0
}

# ---- 6. start the idle slot and wait for its health --------------------------------------------
WriteSlotCmd $idle
$oldPid = PortPid $idle.port
$oldBuild = if ($oldPid) { (Hz $idle.port).build } else { $null }
if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
# The slot directory must END UP being the package root. PowerShell's Move-Item puts a source INSIDE an existing
# destination directory -- that is how a slot once ended up holding only a nested `<dir>.new` with no server/index.js,
# while a leftover process kept answering its health check. So: clear the destination, verify it is gone, move, and
# verify the result; anything short of that rolls back instead of flipping nginx onto a broken tree.
if (Test-Path $idleDir) { Remove-Item $idleDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $idleDir) { Say "the idle slot directory is still there and cannot be cleared ($idleDir) -> nothing done"; exit 1 }
Move-Item $newDir $idleDir
if (-not (Test-Path "$idleDir\server\index.js")) {
  Say "the slot root has no server\index.js after the move -> aborting (the live slot was never touched)"
  Remove-Item $idleDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Start-Process -FilePath "$upd\sp_slot_$($idle.port).cmd" -WindowStyle Hidden | Out-Null
$up = $null
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  Start-Sleep -Seconds 2
  $probe = Hz $idle.port
  # a healthy answer is not enough: a leftover process would answer with the OLD build and look like success
  if ($probe -and $probe.build -and $probe.build -ne $oldBuild) { $up = $probe }
}
if (-not $up) { Say "the new slot did not come up on :$($idle.port) (or answered with the old build) -> leaving nginx where it is"; exit 1 }
Say ("new slot up: app=$($up.app) build=$($up.build)")

# ---- 6b. the served-runtime contract, checked BEFORE nginx is pointed at it ---------------------
$bad = Check-Contract $idle.port $up.build
if ($bad.Count) {
  Say ("contract check failed on :$($idle.port) -> not flipping: " + ($bad -join '; '))
  Say 'the package is asymmetric with the served static graph (see tools/box/README.md)'
  exit 1
}
Say 'contract check passed (module graph + /data versioned, /vendor untouched, immutable policy correct)'

# ---- 7. flip nginx (this process is SYSTEM, so the reload is allowed) --------------------------
[System.IO.File]::WriteAllText("$nx\conf\sp_current.conf", "upstream sp_current {`n    server 127.0.0.1:$($idle.port);`n    keepalive 48;`n}`n")
& "$nx\nginx.exe" -p "$nx/" -c conf/nginx.conf -t 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Say 'nginx config invalid -> not flipping'; exit 1 }
& "$nx\nginx.exe" -p "$nx/" -c conf/nginx.conf -s reload 2>&1 | Out-Null
Start-Sleep -Seconds 4
$via = Hz 3000
if (-not $via -or $via.build -ne $up.build) {
  Say 'the flip did not take effect -> reverting to the old slot'
  [System.IO.File]::WriteAllText("$nx\conf\sp_current.conf", "upstream sp_current {`n    server 127.0.0.1:$($cur.port);`n    keepalive 48;`n}`n")
  & "$nx\nginx.exe" -p "$nx/" -c conf/nginx.conf -s reload 2>&1 | Out-Null
  exit 1
}

# ---- 8. remember what is live ------------------------------------------------------------------
[ordered]@{ active = $idleName; port = $idle.port; dir = $idle.dir; app = $up.app; proto = $up.version
  flippedAt = (Get-Date).ToString('s'); drainingSlot = $activeName; drainingPort = $cur.port } |
  ConvertTo-Json | Set-Content -LiteralPath "$upd\active_slot.json" -Encoding ASCII
[ordered]@{ version = $version; stamp = $stamp; asset = $plan.name; sha256 = (Get-FileHash $zip -Algorithm SHA256).Hash
  deployedAt = (Get-Date).ToString('s'); slot = $idleName; build = $up.build } |
  ConvertTo-Json | Set-Content -LiteralPath $statef -Encoding ASCII

# ---- 8b. self-refresh: the box keeps running the versioned copy of this script ------------------
# The tree we just made live carries tools/box/*; copy it over D:\stronghold\update\ so the scheduled task runs the
# script that shipped with the release instead of an orphan that drifted (this file's header says the same).
try {
  foreach ($pair in @(@('sp_update_zip.ps1', 'sp_update_zip.ps1'), @('sp_update_zip.cmd', 'sp_update_zip.cmd'))) {
    $from = Join-Path $idleDir ("tools/box/" + $pair[0])
    $to = Join-Path $upd $pair[1]
    if (Test-Path $from) {
      if ((Test-Path $to) -and ((Get-FileHash $from).Hash -ne (Get-FileHash $to).Hash)) {
        Copy-Item $to ("{0}.bak-{1}" -f $to, (Get-Date -Format 'yyyyMMdd-HHmm')) -Force -ErrorAction SilentlyContinue
      }
      Copy-Item $from $to -Force
    }
  }
  Say 'self-refresh: tools/box/* copied into the update directory'
} catch { Say ("self-refresh failed (harmless): " + $_.Exception.Message) }

Say "deployed $version to slot $idleName :$($idle.port) -- the old slot :$($cur.port) drains"
Say '=== sp_update_zip done ==='

} finally { Remove-Item $lockf -ErrorAction SilentlyContinue }
