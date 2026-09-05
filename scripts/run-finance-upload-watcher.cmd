@echo off
setlocal
set "BET_CONFIG_PROJECT=C:\Users\Elvis\projects\apostas-lol-data"
"C:\Program Files\nodejs\node.exe" "%~dp0finance-upload-watcher.cjs" --once
exit /b %ERRORLEVEL%
