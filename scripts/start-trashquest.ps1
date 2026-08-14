$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$backendPath = Join-Path $projectRoot 'Backend'
$frontendPath = Join-Path $projectRoot 'Frontend'
$stationEnvPath = Join-Path $projectRoot '.env.station'
$pidFile = Join-Path $projectRoot '.trashquest-processes.json'
$gatewayPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

function Show-Step([string]$message) {
    Write-Host "[TrashQuest] $message" -ForegroundColor Cyan
}

function Require-Path([string]$path, [string]$message) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw $message
    }
}

function Test-Port([int]$port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $port)
        return $connection.Wait(350) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-Port([int]$port, [string]$service, [int]$timeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $port) {
            Write-Host "  $service is ready on port $port." -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$service did not become ready on port $port. Read its terminal for the error."
}

function Start-TrashQuestTerminal([string]$title, [string]$workingDirectory, [string]$command) {
    $escapedTitle = $title.Replace("'", "''")
    $escapedPath = $workingDirectory.Replace("'", "''")
    $terminalScript = "`$Host.UI.RawUI.WindowTitle='$escapedTitle'; Set-Location -LiteralPath '$escapedPath'; $command"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($terminalScript))
    return Start-Process powershell.exe -ArgumentList '-NoProfile', '-NoExit', '-EncodedCommand', $encoded -PassThru
}

try {
    Show-Step 'Checking configuration and dependencies...'
    Require-Path (Join-Path $backendPath '.env') 'Backend\.env is missing.'
    Require-Path $stationEnvPath '.env.station is missing. Copy .env.station.example and configure it.'
    Require-Path $gatewayPython 'The Python virtual environment is missing. Create .venv and install requirements-station.txt.'
    Require-Path (Join-Path $backendPath 'node_modules') 'Backend dependencies are missing. Run npm.cmd install in Backend.'
    Require-Path (Join-Path $frontendPath 'node_modules') 'Frontend dependencies are missing. Run npm.cmd install in Frontend.'

    foreach ($port in @(5001, 5173, 8765)) {
        if (Test-Port $port) {
            throw "Port $port is already occupied. Run stop-trashquest.cmd or close the existing service first."
        }
    }

    $stationText = Get-Content -Raw -LiteralPath $stationEnvPath
    $serialMatch = [regex]::Match($stationText, '(?m)^\s*TQ_SERIAL_PORT\s*=\s*([^\s#]+)')
    if (-not $serialMatch.Success) {
        throw 'TQ_SERIAL_PORT is missing from .env.station.'
    }
    $serialPort = $serialMatch.Groups[1].Value.Trim()
    $availablePorts = [System.IO.Ports.SerialPort]::GetPortNames()
    if ($serialPort -notin $availablePorts) {
        throw "$serialPort is not available. Connected ports: $($availablePorts -join ', ')"
    }

    $processes = @()

    Show-Step 'Starting backend...'
    $backendProcess = Start-TrashQuestTerminal 'TrashQuest Backend' $backendPath 'npm.cmd run dev'
    $processes += [pscustomobject]@{ Name = 'backend'; ProcessId = $backendProcess.Id }
    $processes | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
    Wait-Port 5001 'Backend' 35

    Show-Step 'Starting frontend...'
    $frontendProcess = Start-TrashQuestTerminal 'TrashQuest Frontend' $frontendPath 'npm.cmd run dev'
    $processes += [pscustomobject]@{ Name = 'frontend'; ProcessId = $frontendProcess.Id }
    $processes | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
    Wait-Port 5173 'Frontend' 35

    Show-Step "Starting station gateway on $serialPort..."
    $gatewayProcess = Start-TrashQuestTerminal 'TrashQuest Station Gateway' $projectRoot "& '.\.venv\Scripts\python.exe' station_gateway.py"
    $processes += [pscustomobject]@{ Name = 'gateway'; ProcessId = $gatewayProcess.Id }
    $processes | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
    Wait-Port 8765 'Station gateway' 90

    Show-Step 'All services are ready. Opening TrashQuest...'
    Start-Process 'http://127.0.0.1:5173'
    Write-Host 'Use stop-trashquest.cmd to stop this launch.' -ForegroundColor Green
} catch {
    Write-Host "`nTrashQuest could not start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
