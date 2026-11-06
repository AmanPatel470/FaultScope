# Runs 'npm test' in every service. Usage (from repo root):  .\scripts\test-all.ps1
$root = Split-Path -Parent $PSScriptRoot
$services = 'auth-service', 'payment-service', 'inventory-service', 'notification-service', 'order-service', 'api-gateway'
$failed = @()

foreach ($s in $services) {
    Write-Host "=== $s ===" -ForegroundColor Cyan
    Push-Location (Join-Path $root "services\$s")
    npm test
    if ($LASTEXITCODE -ne 0) { $failed += $s }
    Pop-Location
}

if ($failed.Count -gt 0) {
    Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "All service test suites passed" -ForegroundColor Green