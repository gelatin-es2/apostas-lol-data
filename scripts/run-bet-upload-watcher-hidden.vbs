Option Explicit

Dim shell, scriptDir, command, exitCode
Set shell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
command = """C:\Program Files\nodejs\node.exe"" """ & scriptDir & "bet-upload-watcher.cjs"" --once"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
