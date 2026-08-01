@echo off
cd /d "%~dp0..\.."
if not exist "%~dp0..\..\cron-data\pinnacle-auto" mkdir "%~dp0..\..\cron-data\pinnacle-auto"
"C:\Program Files\nodejs\node.exe" "%~dp0capture_pinnacle_kills_auto.cjs" >> "%~dp0..\..\cron-data\pinnacle-auto\run.log" 2>&1
