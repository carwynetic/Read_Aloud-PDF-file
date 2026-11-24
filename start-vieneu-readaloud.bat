@echo off
title VieNeu Read Aloud Backend (Port 8765)
cd /d "d:\Vscode-luyện code\Read_Aloud"

set "VENV_PY=D:\Vscode-luyện code\OpenMAIC\vieneu-server\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [ERROR] Khong tim thay Python venv tai "%VENV_PY%".
    echo Hay cai dat dependencies tu backend\requirements.txt.
    pause
    exit /b 1
)

echo ============================================================
echo   VieNeu PDF Read Aloud (EN -> VI) Companion Server
echo   Listening on http://127.0.0.1:8765
echo   Reusing VieNeu-TTS environment from OpenMAIC
echo ============================================================

set "PYTHONPATH=d:\Vscode-luyện code\Read_Aloud"
"%VENV_PY%" -m backend.app
pause
