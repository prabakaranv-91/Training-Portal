# Starts Fit Squad locally.
# Creates a virtual environment on first run, installs dependencies, then runs the server.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$venv = Join-Path $root ".venv"
if (-not (Test-Path $venv)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv $venv
}

$py = Join-Path $venv "Scripts\python.exe"

Write-Host "Installing dependencies..." -ForegroundColor Cyan
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r (Join-Path $root "backend\requirements.txt")

Set-Location $root
$port = [int](& $py -c "from backend.utils import app_db; print(app_db.get_setting('app_config', {}).get('port', 8000))")
while ($true) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    try {
        $listener.Start()
        $listener.Stop()
        break
    } catch {
        $port++
    }
}

Write-Host "`nStarting Fit Squad at http://127.0.0.1:$port`n" -ForegroundColor Green
& $py -m uvicorn backend.main:app --host 127.0.0.1 --port $port
