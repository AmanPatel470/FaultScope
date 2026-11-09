# Starts the Anomaly Engine (FastAPI, port 8001) in its own PowerShell window.
# Usage (from repo root):  .\scripts\start-anomaly-engine.ps1
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'anomaly-engine'
$activate = Join-Path $dir '.venv\Scripts\Activate.ps1'
$model = Join-Path $dir 'models\isolation_forest\metadata.json'

if (-not (Test-Path $activate)) {
    Write-Host "Virtual environment missing in $dir - see Phase 4 Step 1" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $model)) {
    Write-Host "No trained model found. From $dir (venv active) run: python -m anomaly_engine.train --seed 0" -ForegroundColor Red
    exit 1
}

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; `$Host.UI.RawUI.WindowTitle = 'anomaly-engine'; . '$activate'; python -m uvicorn anomaly_engine.api:create_app --factory --host 127.0.0.1 --port 8001 --no-access-log"
Write-Host "Started anomaly-engine on http://127.0.0.1:8001 (interactive docs at /docs)"