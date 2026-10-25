param(
    [switch]$Demo
)

$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $backendRoot '.env'

function Test-TcpPort([string]$HostName, [int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync($HostName, $Port)
        if (-not $connect.Wait(1000)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

if (-not (Test-Path $envFile)) {
    throw "Missing $envFile. Copy .env.example to .env and set MONGODB_URI, JWT_ACCESS_SECRET, and JWT_REFRESH_SECRET first."
}

$unhealthyApiDetected = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/v1/public/health' -TimeoutSec 2
    if ($health.success -and $health.data.status -eq 'ok' -and $health.data.database -eq 'connected') {
        Write-Host 'Backend API is already running on port 5000. Use the customer app launcher in another PowerShell window.'
        return
    }
    $unhealthyApiDetected = $true
} catch {
    # No responding API on port 5000; proceed with normal startup.
}

if (-not (Test-TcpPort '127.0.0.1' 27017)) {
    $mongoRoot = Join-Path $env:ProgramFiles 'MongoDB\Server'
    $mongod = Get-ChildItem $mongoRoot -Filter mongod.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName

    if (-not $mongod) {
        throw 'MongoDB is not listening on 127.0.0.1:27017 and mongod.exe was not found. Install MongoDB Community Server or start your configured MongoDB service.'
    }

    $dataPath = Join-Path $backendRoot '.local-db'
    $logPath = Join-Path $backendRoot 'mongo-dev.log'
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $mongoArgs = "--dbpath `"$dataPath`" --bind_ip 127.0.0.1 --port 27017 --wiredTigerCacheSizeGB 1 --logpath `"$logPath`" --logappend"
    Start-Process -FilePath $mongod -ArgumentList $mongoArgs -WindowStyle Hidden

    $mongoReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-TcpPort '127.0.0.1' 27017) {
            $mongoReady = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $mongoReady) { throw "MongoDB did not start. Check $logPath." }
}

if (Test-TcpPort '127.0.0.1' 5000) {
    $listeners = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
    $listenerIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $ownedBackendProcesses = @(Get-CimInstance Win32_Process | Where-Object {
        $listenerIds -contains $_.ProcessId -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($backendRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match 'src[\\/]server\.js'
    })

    if ($unhealthyApiDetected -and $ownedBackendProcesses.Count -gt 0) {
        foreach ($process in $ownedBackendProcesses) {
            Write-Host "Stopping stale project API process $($process.ProcessId); MongoDB was unavailable when it started."
            Stop-Process -Id $process.ProcessId -Force
        }
        Start-Sleep -Seconds 2
    }

    if (Test-TcpPort '127.0.0.1' 5000) {
        throw 'Port 5000 is still in use. Stop the old backend (Ctrl+C in its terminal), then run this script again.'
    }
}

Push-Location $backendRoot
try {
    if ($Demo) { npm run seed -- --demo } else { npm run seed }
    if ($LASTEXITCODE -ne 0) { throw 'Database seed failed.' }

    Write-Host 'Starting the API. Press Ctrl+C to stop it.'
    npm start
    if ($LASTEXITCODE -ne 0) { throw 'Backend API stopped with an error.' }
} finally {
    Pop-Location
}
