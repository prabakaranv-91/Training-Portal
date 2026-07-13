# Starts the Garmin Training Portal locally.
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

Write-Host "`nStarting portal at http://127.0.0.1:8000`n" -ForegroundColor Green
Set-Location (Join-Path $root "backend")
& $py main.py
