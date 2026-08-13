@echo off
setlocal
"C:\Program Files\nodejs\node.exe" "%~dp0bet-upload-watcher.cjs" --once
exit /b %ERRORLEVEL%
