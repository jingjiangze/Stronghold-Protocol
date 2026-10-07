param([string]$Task, [int]$Port = 0, [string]$Proc = "", [string]$LogPath = "D:\stronghold\logs\connector-guard.log")
$ErrorActionPreference = "Continue"
# Health is decided by effect, not by a process count: a shared machine may run several
# cloudflared connectors, and a token in the process list is not always a decodable JWT.
$t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
$st = if ($t) { [string]$t.State } else { "" }
$note = "state=$st"
$ok = ($st -eq "Running")
if ($Proc -ne "" -and @(Get-Process $Proc -ErrorAction SilentlyContinue).Count -gt 0) { $ok = $true; $note += " proc=up" }
if ($Port -gt 0) {
  $l = @(netstat -ano | Select-String -Pattern (":" + $Port + "\s") | Select-String -Pattern "LISTENING").Count
  $note += " port=$l"
  # A listening port wins: the service may have been started by hand, and restarting it
  # would cut live player connections for nothing.
  if ($l -gt 0) { $ok = $true } else { $ok = $false }
}
if ($ok) { exit 0 }
$dir = Split-Path $LogPath -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 65536)) { (Get-Content $LogPath -Tail 300) | Set-Content -LiteralPath $LogPath -Encoding ASCII }
Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format "s") + " " + $Task + " " + $note + " -> run") -Encoding ASCII
& schtasks.exe /Run /TN $Task 2>&1 | ForEach-Object { Add-Content -LiteralPath $LogPath -Value ("   run: " + $_) -Encoding ASCII }
exit 0
