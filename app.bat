@echo off
REM Double-clickable launcher. All the logic lives in app.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" %*
