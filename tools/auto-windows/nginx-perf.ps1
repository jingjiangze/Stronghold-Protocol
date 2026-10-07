# nginx-perf.ps1 -- idempotent Windows-throughput patch for the Stronghold front.
# Why: nginx on Windows does not implement sendfile, and the game pulls thousands of
# small asset files per new player; without an open-file cache every one of them costs a
# fresh stat()+open() on the box's spinning disk while its uplink is the real bottleneck.
param([string]$NginxRoot = 'D:\stronghold\nginx')
$ErrorActionPreference = 'Continue'
$confPath = Join-Path $NginxRoot 'conf\nginx.conf'
$conf = [IO.File]::ReadAllText($confPath)

if ($conf -match 'open_file_cache') { Write-Output 'already patched'; }
else {
  $cache = @(
    '  # Windows nginx has no sendfile; buffered output + an open-file cache is the fast path here',
    '  output_buffers   2 512k;',
    '  open_file_cache          max=60000 inactive=30m;',
    '  open_file_cache_valid    60m;',
    '  open_file_cache_min_uses 2;',
    '  open_file_cache_errors   on;'
  ) -join "`r`n"
  $conf = $conf.Replace('  sendfile      on;', "  sendfile      off;`r`n" + $cache)
  [IO.File]::WriteAllText($confPath, $conf, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output 'patched: sendfile off + output_buffers + open_file_cache'
}

$exe = Join-Path $NginxRoot 'nginx.exe'
& $exe -p ($NginxRoot + '\') -c 'conf\nginx.conf' -t 2>&1 | ForEach-Object { Write-Output "t: $_" }
if ($LASTEXITCODE -ne 0) { Write-Error 'config invalid, nothing reloaded'; exit 2 }
& $exe -p ($NginxRoot + '\') -c 'conf\nginx.conf' -s reload 2>&1 | Out-Null
Start-Sleep -Seconds 3

# measure the thing we changed: 40 small media requests on loopback
$pub = Split-Path (Split-Path $confPath) -Parent
$root = 'D:\stronghold\Stronghold-Protocol\public\assets\audio'
if (-not (Test-Path $root)) { Write-Output 'asset root not found, skipping timing'; exit 0 }
$ms = @()
foreach ($f in (Get-ChildItem (Join-Path $root 'sfx') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 40)) {
  $rel = ($f.FullName.Substring($root.Length + 1) -replace '\\', '/') -replace '\.mp3$', ''
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { Invoke-WebRequest -Uri "http://127.0.0.1:8080/media/$rel" -UseBasicParsing -TimeoutSec 10 | Out-Null } catch {}
  $sw.Stop(); $ms += $sw.Elapsed.TotalMilliseconds
}
if ($ms.Count) {
  $s = $ms | Sort-Object
  Write-Output ('small-file loopback: n=' + $s.Count + ' median=' + [math]::Round($s[[int]($s.Count / 2)], 2) +
    'ms p90=' + [math]::Round($s[[int]($s.Count * 0.9)], 2) + 'ms max=' + [math]::Round($s[-1], 2) + 'ms')
}
