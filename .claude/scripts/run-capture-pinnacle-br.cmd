@echo off
cd /d "%~dp0..\.."
if not exist "%~dp0..\..\cron-data\pinnacle-br" mkdir "%~dp0..\..\cron-data\pinnacle-br"
"C:\Program Files\nodejs\node.exe" "%~dp0capture_pinnacle_br_to_supabase.cjs" >> "%~dp0..\..\cron-data\pinnacle-br\run.log" 2>&1
