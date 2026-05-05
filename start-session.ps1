# start-session.ps1 — boot da próxima sessão de trabalho no apostas-lol-data
#
# O que faz:
#   1. cd pro diretório do repo
#   2. Refresh do PATH (caso git/node/gh tenham sido instalados na sessão anterior)
#   3. git pull (pega commits do cron auto que rodou desde a última sessão)
#   4. Mostra resumo: últimos commits, status, runs recentes do GitHub Actions
#   5. Abre VS Code na pasta
#
# Uso (de qualquer lugar):
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\projects\apostas-lol-data\start-session.ps1"
#
# Ou cria um atalho no Desktop apontando pra esse script.

$ErrorActionPreference = 'Continue'
$repo = "$env:USERPROFILE\projects\apostas-lol-data"

if (-not (Test-Path $repo)) {
    Write-Host "ERRO: $repo não existe. Clone o repo primeiro." -ForegroundColor Red
    exit 1
}

Set-Location $repo

# Refresh PATH (caso ferramentas tenham sido instaladas em sessão anterior)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  apostas-lol-data — boot de sessão" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Pull
Write-Host "[1/4] git pull..." -ForegroundColor Yellow
git pull --quiet 2>&1 | ForEach-Object { Write-Host "  $_" }

# 2. Últimos commits
Write-Host ""
Write-Host "[2/4] Últimos commits:" -ForegroundColor Yellow
git log --oneline -8

# 3. Status
Write-Host ""
Write-Host "[3/4] Status (working tree):" -ForegroundColor Yellow
$status = git status --short
if ($status) { Write-Host $status } else { Write-Host "  (limpo)" -ForegroundColor Green }

# 4. GitHub Actions recentes (se gh disponível)
Write-Host ""
Write-Host "[4/4] Runs recentes do GitHub Actions (daily-cron):" -ForegroundColor Yellow
$ghAvailable = Get-Command gh -ErrorAction SilentlyContinue
if ($ghAvailable) {
    gh run list --workflow=daily-cron.yml --limit 3 2>&1 | ForEach-Object {
        if ($_ -match "completed.*success") { Write-Host "  $_" -ForegroundColor Green }
        elseif ($_ -match "completed.*failure") { Write-Host "  $_" -ForegroundColor Red }
        else { Write-Host "  $_" }
    }
} else {
    Write-Host "  (gh CLI não instalado — pula)"
}

# 5. Próximos passos do NEXT-SESSION.md
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Próximos passos (de NEXT-SESSION.md):" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
$nextFile = Join-Path $repo "NEXT-SESSION.md"
if (Test-Path $nextFile) {
    $content = Get-Content $nextFile -Raw
    $top5Match = [regex]::Match($content, '(?s)## Top 5 próximos passos.*?(?=---)')
    if ($top5Match.Success) {
        $top5Match.Value -split "`n" | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "  (seção 'Top 5' não encontrada — leia NEXT-SESSION.md direto)"
    }
} else {
    Write-Host "  NEXT-SESSION.md não encontrado." -ForegroundColor Red
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Próximas ações recomendadas:" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  1. VS Code abre em seguida nessa pasta"
Write-Host "  2. Dentro do VS Code, abre Claude Code"
Write-Host "  3. Digita: /resume"
Write-Host "  4. Confirma direção e segue"
Write-Host ""

# 6. Abre VS Code
$codeAvailable = Get-Command code -ErrorAction SilentlyContinue
if ($codeAvailable) {
    Write-Host "Abrindo VS Code..." -ForegroundColor Green
    & code .
} else {
    Write-Host "VS Code (comando 'code') não encontrado no PATH." -ForegroundColor Yellow
    Write-Host "Abre o VS Code manualmente e abre a pasta:" -ForegroundColor Yellow
    Write-Host "  $repo" -ForegroundColor White
}
