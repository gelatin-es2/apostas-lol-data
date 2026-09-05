# uninstall-finance-upload-watcher.ps1
# DESABILITA a tarefa do Finance Upload Watcher (ApostasLoL-FinanceUploadWatcher) sem
# remove-la: a definicao/config/historico ficam intactos no Agendador, so param de
# disparar. Rodar tools\install-finance-upload-watcher.ps1 de novo re-habilita com a
# config mais recente.
#
# Roda a limpeza de processo orfao MESMO que a tarefa ja esteja desabilitada ou ausente
# (pode ter sobrado node.exe de um disparo anterior que nao terminou a tempo do
# ExecutionTimeLimit) - por isso nao sai cedo demais.
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools\uninstall-finance-upload-watcher.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName    = 'ApostasLoL-FinanceUploadWatcher'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WatcherPath = Join-Path $ProjectRoot 'scripts\finance-upload-watcher.cjs'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "desabilitando a tarefa '$TaskName' (estado atual: $($task.State))..."
    try {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        Write-Host "  '$TaskName' desabilitada." -ForegroundColor Green
    } catch {
        Write-Host "  ERRO ao desabilitar '$TaskName': $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  Se falar de permissao, abra o PowerShell como Administrador e rode de novo." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Nao tem tarefa '$TaskName' instalada." -ForegroundColor Yellow
}

# Cada disparo do watcher e um --once que sobe e sai sozinho; um orfao aqui so acontece
# se o cmd.exe/node.exe sobreviver alem do ExecutionTimeLimit por algum motivo externo.
# taskkill /T mata a arvore de verdade (cmd.exe -> claude -> node.exe netos incluidos).
Start-Sleep -Seconds 1
$orphans = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$WatcherPath*" })

if ($orphans.Count -gt 0) {
    Write-Host ""
    Write-Host "encontrei $($orphans.Count) processo(s) node.exe do Finance Upload Watcher que ficaram orfaos - encerrando..." -ForegroundColor Yellow
    foreach ($p in $orphans) {
        Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/F', '/T', '/PID', $p.ProcessId) -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
        Write-Host "  encerrado: PID $($p.ProcessId)"
    }
} elseif (-not $task) {
    Write-Host "Nada pra limpar: sem tarefa e sem processo orfao."
    exit 0
}

Write-Host ""
Write-Host "limpeza concluida." -ForegroundColor Green
Write-Host ""
Write-Host "Pronto: o modo automatico do Finance Upload Watcher foi desligado." -ForegroundColor Cyan
Write-Host "A tarefa continua registrada (desabilitada) - rode tools\install-finance-upload-watcher.ps1 pra religar." -ForegroundColor Cyan
