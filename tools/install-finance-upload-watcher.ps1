# install-finance-upload-watcher.ps1
# Cria (ou atualiza) e HABILITA a tarefa do Agendador de Tarefas que roda o Finance
# Upload Watcher sozinho, sem janela, uma vez por minuto (o watcher em si roda em
# modo --once por chamada e sai — nao e um processo 24/7 como o Vigia Pinnacle).
#
# Tarefa: ApostasLoL-FinanceUploadWatcher
#   - dispara a cada 1 min, comecando na instalacao, indefinidamente
#   - roda scripts\run-finance-upload-watcher-hidden.vbs via wscript, sem janela
#   - limite de execucao de 15 min por disparo (acima do WORKER_TIMEOUT_MS interno de
#     8 min do watcher, que ja mata a arvore do processo do worker sozinho) - esse limite
#     do Agendador e so uma rede de seguranca externa contra um cmd.exe/node.exe que
#     nunca saia por algum motivo fora do controle do script.
#
# Rodar de novo este script NAO duplica nada (idempotente): sempre sobrescreve a tarefa
# existente com a configuracao mais recente e garante que ela fique HABILITADA, mesmo se
# tinha sido desligada antes por tools\uninstall-finance-upload-watcher.ps1.
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools\install-finance-upload-watcher.ps1
#
# ATENCAO: registrar tarefa no Agendador do Windows e acao de risco medio/alto (roda
# escondida, sobrevive a reboot, mexe em Supabase de producao via o worker). Rodar este
# script SO com aprovacao explicita do usuario. Este script so ESCREVE a definicao da
# tarefa quando executado por alguem — o agente que preparou este arquivo NAO rodou
# schtasks/Register-ScheduledTask.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName    = 'ApostasLoL-FinanceUploadWatcher'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VbsPath     = Join-Path $ProjectRoot 'scripts\run-finance-upload-watcher-hidden.vbs'
$CmdPath     = Join-Path $ProjectRoot 'scripts\run-finance-upload-watcher.cmd'
$WatcherPath = Join-Path $ProjectRoot 'scripts\finance-upload-watcher.cjs'

Write-Host "== instalando autostart do Finance Upload Watcher ==" -ForegroundColor Cyan
Write-Host "pasta do projeto (worktree): $ProjectRoot"

foreach ($required in @($VbsPath, $CmdPath, $WatcherPath)) {
    if (-not (Test-Path $required)) {
        Write-Host "ERRO: nao achei $required - confira se esta rodando a partir do worktree correto." -ForegroundColor Red
        exit 1
    }
}

$WscriptExe = (Get-Command wscript.exe -ErrorAction SilentlyContinue).Source
if (-not $WscriptExe) { $WscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe' }

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $NodeExe)) {
    Write-Host "AVISO: nao achei node.exe nem no PATH nem em C:\Program Files\nodejs\node.exe." -ForegroundColor Yellow
    Write-Host "        o wrapper vai tentar 'node' pelo PATH mesmo assim - instale o Node se falhar."
}

$ClaudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $ClaudeExe) {
    Write-Host "AVISO: nao achei 'claude' no PATH deste shell. O watcher so consegue subir o worker" -ForegroundColor Yellow
    Write-Host "        (Claude Code headless) se 'claude' estiver no PATH do usuario que roda a tarefa" -ForegroundColor Yellow
    Write-Host "        (esperado em C:\Users\Elvis\.local\bin\claude.exe)." -ForegroundColor Yellow
}

$User = $env:USERNAME

# ---------------------------------------------------------------- trigger: a cada 1 min
# Nao existe trigger nativo "repita pra sempre" no Agendador via New-ScheduledTaskTrigger;
# o idioma padrao pra isso e um trigger "Once" com RepetitionInterval de 1 min e
# RepetitionDuration bem longa (aqui, 10 anos). StartWhenAvailable garante que disparos
# perdidos (PC desligado, em espera) rodem assim que o PC voltar.
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$Action = New-ScheduledTaskAction -Execute $WscriptExe -Argument ('"' + $VbsPath + '"') -WorkingDirectory $ProjectRoot

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
        -Settings $Settings -Principal $Principal -Force `
        -Description 'Roda o Finance Upload Watcher (extracao de fatura/extrato por foto via Claude Code headless) a cada 1 min, sem janela.' | Out-Null
} catch {
    Write-Host "ERRO ao registrar a tarefa: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Se a mensagem falar de permissao/acesso negado, abra o PowerShell como Administrador e rode de novo." -ForegroundColor Red
    exit 1
}
Write-Host "tarefa '$TaskName' criada/atualizada." -ForegroundColor Green

# Garante habilitada mesmo se a tarefa ja existia desligada por uninstall-finance-upload-watcher.ps1.
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Write-Host "tarefa '$TaskName' habilitada." -ForegroundColor Green

Write-Host ""
Write-Host "-- conferindo o que ficou registrado --"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object @{n='Tarefa';e={$TaskName}}, LastRunTime, LastTaskResult, NextRunTime | Format-Table -AutoSize | Out-String | Write-Host

Write-Host ""
Write-Host "PRONTO. A partir de agora o Finance Upload Watcher roda 1x por minuto, sem janela," -ForegroundColor Cyan
Write-Host "processando no maximo um job de upload por chamada." -ForegroundColor Cyan
Write-Host "Log do worker (Claude Code): cron-data\finance-upload-work\logs\worker-AAAA-MM-DD.log" -ForegroundColor Cyan
Write-Host "Para desligar o automatico:  powershell -File tools\uninstall-finance-upload-watcher.ps1" -ForegroundColor Cyan
