$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.trashquest-processes.json'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No TrashQuest launch record was found. Nothing was stopped.' -ForegroundColor Yellow
    exit 0
}

try {
    # Windows PowerShell 5 can preserve a JSON array as one nested pipeline
    # object when wrapped with @(...). Assign it directly so foreach enumerates
    # each recorded service entry and taskkill receives one numeric PID.
    $entries = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
    foreach ($entry in $entries) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            Write-Host "Stopping TrashQuest $($entry.Name) (PID $($entry.ProcessId))..." -ForegroundColor Cyan
            & taskkill.exe /PID $entry.ProcessId /T /F | Out-Null
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'TrashQuest services from the recorded launch were stopped.' -ForegroundColor Green
} catch {
    Write-Host "Could not stop TrashQuest cleanly: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
