# Deployment Guide — VieNeu Read Aloud

## Architecture
- **Browser Extension**: Chrome / Microsoft Edge Manifest V3 unpacked bundle at `extension/dist/`.
- **Local Companion Server**: Python FastAPI server (`backend/app.py`) on `http://127.0.0.1:8765`, reusing the installed VieNeu-TTS environment at `D:\Vscode-luyện code\OpenMAIC\vieneu-server\.venv`.

## Build & Local Release
1. Rebuild extension bundle after any UI/core changes:
   ```powershell
   cd "d:\Vscode-luyện code\Read_Aloud\extension"
   npm test
   npm run build
   ```
2. Reload unpacked extension in `chrome://extensions/` or `edge://extensions/` pointing to `d:\Vscode-luyện code\Read_Aloud\extension\dist`.
3. Start companion server with `start-vieneu-readaloud.bat` or `start-vieneu-readaloud.ps1`.

## Environment Variables (Optional)
| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8765` | Port for local companion backend |
| `VIENEU_UPSTREAM_URL` | `http://127.0.0.1:8000` | Existing OpenMAIC VieNeu-TTS server to proxy when active |
| `VIENEU_PRECISION` | `int8` | ONNX/CPU precision (`int8` or `fp32`) when loading locally |
| `VIENEU_WARMUP` | `1` | Pre-warm VieNeu model on startup (`0` to defer until first request) |
| `READALOUD_LLM_BASE_URL` | — | Optional OpenAI-compatible translation endpoint |
| `READALOUD_LLM_API_KEY` | — | Optional API key for LLM translation |
| `READALOUD_LLM_MODEL` | `gpt-4o-mini` | Model name when using LLM translation |
