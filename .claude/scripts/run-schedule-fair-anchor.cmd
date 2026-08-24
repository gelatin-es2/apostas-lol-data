@echo off
cd /d "%~dp0..\.."
if not exist "%~dp0..\..\cron-data\fair-anchor" mkdir "%~dp0..\..\cron-data\fair-anchor"
"C:\Program Files\nodejs\node.exe" "%~dp0schedule-fair-anchor-capture.cjs" >> "%~dp0..\..\cron-data\fair-anchor\run.log" 2>&1
