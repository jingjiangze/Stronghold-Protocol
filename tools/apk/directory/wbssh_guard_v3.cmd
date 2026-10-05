@echo off
sc query sshd | findstr /C:"RUNNING" >nul
if errorlevel 1 (
  sc config sshd start= auto >nul 2>&1
  net start sshd >nul 2>&1
  echo %date% %time% sshd was down, set auto + started >> D:\web\cf\wbssh_guard.log
)
wmic process where "name='cloudflared.exe'" get commandline 2>nul | findstr /C:"tunnel run --token" >nul
if errorlevel 1 (
  schtasks /run /tn WbSshTunnel >nul 2>&1
  echo %date% %time% wbssh connector missing, WbSshTunnel restarted >> D:\web\cf\wbssh_guard.log
)
netstat -ano | findstr /C:"LISTENING" | findstr /R /C:":3000[^0-9]" >nul
if errorlevel 1 (
  schtasks /run /tn StrongholdServer >nul 2>&1
  echo %date% %time% stronghold not listening, StrongholdServer restarted >> D:\web\cf\wbssh_guard.log
)
netstat -ano | findstr /C:"LISTENING" | findstr /R /C:":8793[^0-9]" >nul
if errorlevel 1 (
  schtasks /run /tn SpDirectory >nul 2>&1
  echo %date% %time% directory not listening, SpDirectory restarted >> D:\web\cf\wbssh_guard.log
)
