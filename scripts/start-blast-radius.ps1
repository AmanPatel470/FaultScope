# Starts the Blast Radius Engine (FastAPI) in its own PowerShell window.
# Usage (from repo root):  .\scripts\start-blast-radius.ps1
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'blast-radius-engine'
$activate = Join-Path $dir '.venv\Scripts\Activate.ps1'

if (-not (Test-Path $activate)) {
    Write-Host "Virtual environment missing in $dir - see Phase 3 Part 1, Step 2" -ForegroundColor Red
    exit 1
}

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; `$Host.UI.RawUI.WindowTitle = 'blast-radius-engine'; . '$activate'; python -m uvicorn blast_radius.api:app --host 127.0.0.1 --port 8002 --no-access-log"
Write-Host "Started blast-radius-engine on http://127.0.0.1:8002 (interactive docs at /docs)"