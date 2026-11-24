$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ParentDir = Split-Path -Parent $Root

$LocalVenv = Join-Path $Root ".venv\Scripts\python.exe"
$OpenMaicVenv = Join-Path $ParentDir "OpenMAIC\vieneu-server\.venv\Scripts\python.exe"

$VenvPy = if (Test-Path $LocalVenv) { $LocalVenv } else { $OpenMaicVenv }

if (-not (Test-Path $VenvPy)) {
    Write-Error "Khong tim thay VieNeu venv tai $VenvPy. Hay cai dat tu backend/requirements.txt."
    exit 1
}

$env:PYTHONPATH = $Root
$env:PYTHONUTF8 = "1"
Write-Host "Starting VieNeu Read Aloud Backend on http://127.0.0.1:8765 ..." -ForegroundColor Green
Write-Host "Using Python: $VenvPy" -ForegroundColor DarkGray
& $VenvPy -m backend.app
