' Executa um .cmd sem janela (usado pelas tasks agendadas deste projeto)
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count >= 1 Then
  sh.Run """" & WScript.Arguments(0) & """", 0, False
End If
