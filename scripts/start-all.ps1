# Starts all six services, each in its own PowerShell window (npm run dev).
# Usage (from repo root):  .\scripts\start-all.ps1
$root = Split-Path -Parent $PSScriptRoot
$services = 'auth-service', 'payment-service', 'inventory-service', 'notification-service', 'order-service', 'api-gateway'

foreach ($s in $services) {
    $dir = Join-Path $root "services\$s"

    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host "node_modules missing for $s - run 'npm install' in $dir first" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path (Join-Path $dir '.env'))) {
        Copy-Item (Join-Path $dir '.env.example') (Join-Path $dir '.env')
        Write-Host "Created .env for $s"
    }

    Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; `$Host.UI.RawUI.WindowTitle = '$s'; npm run dev"
}

Write-Host "Started 6 services. Give them ~3 seconds, then check http://localhost:3000/health/services"
Write-Host "Stop a service by pressing Ctrl+C in its window (or close the window)."