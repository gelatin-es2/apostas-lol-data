[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$preflightPath = Join-Path $repoRoot 'migrations\2026-08-14-bet-upload-batch.preflight.sql'
$migrationPath = Join-Path $repoRoot 'migrations\2026-08-14-bet-upload-batch.sql'
$rollbackPath = Join-Path $repoRoot 'migrations\2026-08-14-bet-upload-batch.rollback.sql'
$databaseUrl = [Environment]::GetEnvironmentVariable('SUPABASE_DB_URL')

if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  throw 'SUPABASE_DB_URL ausente. Configure somente no ambiente; nao passe credencial por argumento.'
}

foreach ($commandName in @('psql', 'pg_dump')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "$commandName ausente do PATH"
  }
}

$backupRoot = if ($OutputDirectory) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $repoRoot 'cron-data\migration-backups'
}
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$runDirectory = Join-Path $backupRoot "bet-upload-batch-$timestamp"
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

$schemaBackup = Join-Path $runDirectory 'schema.sql'
$dataBackup = Join-Path $runDirectory 'bets-and-jobs-data.sql'
$preflightOutput = Join-Path $runDirectory 'preflight.txt'
$runManifest = Join-Path $runDirectory 'manifest.json'

& pg_dump --dbname=$databaseUrl --schema-only --no-owner --no-privileges `
  --table=public.bets --table=public.bet_upload_jobs --file=$schemaBackup
if ($LASTEXITCODE -ne 0) { throw "pg_dump schema falhou: exit $LASTEXITCODE" }

& pg_dump --dbname=$databaseUrl --data-only --column-inserts --no-owner --no-privileges `
  --table=public.bets --table=public.bet_upload_jobs --file=$dataBackup
if ($LASTEXITCODE -ne 0) { throw "pg_dump data falhou: exit $LASTEXITCODE" }

& psql $databaseUrl -X --set=ON_ERROR_STOP=1 --file=$preflightPath *>&1 |
  Set-Content -LiteralPath $preflightOutput -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "preflight falhou: exit $LASTEXITCODE; veja $preflightOutput" }

$files = @($schemaBackup, $dataBackup, $preflightOutput, $preflightPath, $migrationPath, $rollbackPath)
$manifest = [ordered]@{
  created_at = [DateTime]::UtcNow.ToString('o')
  git_commit = (git -C $repoRoot rev-parse HEAD).Trim()
  database_host = ([Uri]$databaseUrl).Host
  executed_migration = $false
  files = @($files | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    [ordered]@{
      path = $item.FullName
      bytes = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant()
    }
  })
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runManifest -Encoding utf8

Write-Output "Backup e preflight concluidos: $runDirectory"
Write-Output 'Migration NAO executada.'
