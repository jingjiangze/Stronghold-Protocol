@echo off
rem Stronghold Tunnel B (redundant CF tunnel) — token read from tunnelB_tok.txt.
set /p TBTOK=<D:\stronghold\tunnelB_tok.txt
D:\web\cf\cloudflared.exe --no-autoupdate tunnel run --token %TBTOK% >> D:\stronghold\tunnelB.log 2>&1
