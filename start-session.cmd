@echo off
REM Companion do start-session.ps1 — executa com bypass de ExecutionPolicy.
REM Duplo-clique nesse arquivo no Explorer abre tudo.
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0start-session.ps1"
pause
