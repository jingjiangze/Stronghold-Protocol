@echo off
rem Stronghold box: keep the deployment on the newest package of OUR release (sp_update_zip.ps1).
rem Runs as SYSTEM so nginx can be reloaded (an interactive session cannot open its Global\ngx_reload_<pid> event).
rem This file ships inside every release package and refreshes D:\stronghold\update\ after a good deploy -- do not
rem hand-edit the box's copy.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File D:\stronghold\update\sp_update_zip.ps1
