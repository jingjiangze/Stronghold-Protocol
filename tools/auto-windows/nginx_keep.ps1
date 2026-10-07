# nginx_keep.ps1 -- tiny supervisor: nginx runs in the foreground inside its own task,
# so this only matters when that instance has ended (crash, manual kill, reboot race).
param([string]$Config = 'D:\stronghold\update\config.json')
$ErrorActionPreference = 'Continue'
$C = Get-Content $Config -Raw | ConvertFrom-Json
$exe = Join-Path $C.nginxDir 'nginx.exe'
$alive = @(Get-Process nginx -ErrorAction SilentlyContinue)
if ($alive.Count -ge 2) { exit 0 }
$logsDir = Join-Path $C.nginxDir 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
Write-Output ("{0} nginx procs={1} -> starting" -f (Get-Date -Format 's'), $alive.Count)
Start-Process -FilePath $exe -ArgumentList @('-p', ($C.nginxDir.Replace('\', '/') + '/'), '-c', 'conf/nginx.conf') -WindowStyle Hidden | Out-Null
