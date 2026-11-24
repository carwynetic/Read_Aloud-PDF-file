@echo off
chcp 65001 >nul
setlocal EnableExtensions
title VieNeu Read Aloud Backend (Port 8765)

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

set "VENV_PY=%ROOT%\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    for %%I in ("%ROOT%\..\OpenMAIC\vieneu-server\.venv\Scripts\python.exe") do set "VENV_PY=%%~fI"
)

if not exist "%VENV_PY%" (
    echo [ERROR] Khong tim thay Python venv tai "%VENV_PY%".
    echo Hay cai dat dependencies tu backend\requirements.txt.
    pause
    exit /b 1
)

echo ============================================================
echo   VieNeu PDF Read Aloud (EN -^> VI) Companion Server
echo   Listening on http://127.0.0.1:8765
echo   Python: %VENV_PY%
echo ============================================================

set "PYTHONPATH=%ROOT%"
set "PYTHONUTF8=1"
"%VENV_PY%" -m backend.app
pause
