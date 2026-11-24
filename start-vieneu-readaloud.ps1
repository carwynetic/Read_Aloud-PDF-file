$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPy = "D:\Vscode-luyện code\OpenMAIC\vieneu-server\.venv\Scripts\python.exe"

if (-not (Test-Path $VenvPy)) {
    Write-Error "Khong tim thay VieNeu venv tai $VenvPy. Hay cai dat tu backend/requirements.txt."
    exit 1
}

$env:PYTHONPATH = $Root
Write-Host "Starting VieNeu Read Aloud Backend on http://127.0.0.1:8765 ..." -ForegroundColor Green
& $VenvPy -m backend.app
