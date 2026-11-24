"""FastAPI server for VieNeu Read Aloud Chrome/Edge extension."""

from __future__ import annotations

import base64
from contextlib import asynccontextmanager
import io
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.alignment import compute_word_timings
from backend.cache import DiskLRUCache
from backend.translator import (
    GoogleFetcher,
    TranslationConfig,
    get_key_pools,
    load_local_env,
    translate_text,
)
from backend.tts_engine import HybridVieNeuEngine

load_local_env()


class TranslateRequest(BaseModel):
    text: str
    provider: str = "smart_ai"
    source_lang: str = "en"
    target_lang: str = "vi"
    openai_base_url: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None


class ReadSentenceRequest(BaseModel):
    text: str = Field(..., description="Original PDF sentence text")
    voice: str = Field(default="hai_dang", description="Preset or cloned voice ID")
    translate: bool = Field(default=True, description="Whether to translate EN -> VI")
    provider: str = Field(default="smart_ai", description="smart_ai | groq | gemini | google | openai | passthrough")
    source_lang: str = Field(default="en")
    target_lang: str = Field(default="vi")
    openai_base_url: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None


def _encode_wav_base64(audio: np.ndarray, sample_rate: int) -> str:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def create_app(
    tts_engine: Optional[Any] = None,
    cache_dir: Optional[Path] = None,
    google_fetcher: Optional[GoogleFetcher] = None,
    warm_up_on_start: bool = False,
) -> FastAPI:
    engine = tts_engine or HybridVieNeuEngine()
    default_cache_dir = cache_dir or (Path(__file__).parent / ".cache")
    cache = DiskLRUCache(default_cache_dir, max_items=400)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if warm_up_on_start and hasattr(engine, "warm_up"):
            engine.is_warming_up = True
            threading.Thread(target=engine.warm_up, name="vieneu-warmup", daemon=True).start()
        yield

    app = FastAPI(title="VieNeu Read Aloud Backend", version="1.0.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        warming = bool(getattr(engine, "is_warming_up", False))
        groq_pool, gemini_pool = get_key_pools()
        return {
            "status": "warming_up" if warming else "healthy",
            "ready": not warming,
            "service": "vieneu-read-aloud",
            "tts_mode": getattr(engine, "backend_mode", "unknown"),
            "sample_rate": getattr(engine, "sample_rate", 48000),
            "ai_translators": {
                "groq_keys": len(groq_pool),
                "gemini_keys": len(gemini_pool),
            },
            "warmup_error": getattr(engine, "warmup_error", None),
        }

    @app.get("/api/voices")
    def voices():
        return engine.list_voices()

    @app.post("/api/translate")
    def api_translate(req: TranslateRequest):
        raw = (req.text or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Text cannot be empty.")

        cfg = TranslationConfig(
            provider=req.provider,
            source_lang=req.source_lang,
            target_lang=req.target_lang,
            openai_base_url=req.openai_base_url,
            openai_api_key=req.openai_api_key,
            openai_model=req.openai_model,
        )
        t_key = cache.make_key("tr", raw, cfg.provider, cfg.source_lang, cfg.target_lang, cfg.openai_model or "")
        cached = cache.get_json(t_key)
        if cached:
            return {**cached, "cached": True}

        try:
            res = translate_text(raw, config=cfg, google_fetcher=google_fetcher)
        except Exception as err:
            raise HTTPException(status_code=502, detail=f"Translation failed: {err}")

        payload = {
            "sourceText": res.source_text,
            "cleanedSourceText": res.cleaned_source_text,
            "translatedText": res.translated_text,
            "wasTranslated": res.was_translated,
            "provider": res.provider,
        }
        cache.set_json(t_key, payload)
        return {**payload, "cached": False}

    @app.post("/api/read-sentence")
    def read_sentence(req: ReadSentenceRequest):
        raw = (req.text or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Text cannot be empty.")

        t0 = time.perf_counter()
        effective_provider = req.provider if req.translate else "passthrough"
        cfg = TranslationConfig(
            provider=effective_provider,
            source_lang=req.source_lang,
            target_lang=req.target_lang,
            openai_base_url=req.openai_base_url,
            openai_api_key=req.openai_api_key,
            openai_model=req.openai_model,
        )

        full_key = cache.make_key(
            "read",
            raw,
            req.voice,
            cfg.provider,
            cfg.source_lang,
            cfg.target_lang,
            cfg.openai_model or "",
        )
        cached_meta = cache.get_json(full_key)
        cached_wav = cache.get_bytes(full_key) if cached_meta else None
        if cached_meta and cached_wav:
            return {
                **cached_meta,
                "audioBase64": base64.b64encode(cached_wav).decode("ascii"),
                "cached": True,
                "latencyMs": int(round((time.perf_counter() - t0) * 1000)),
            }

        # Check translation-only cache first so parallel /api/translate preview is reused cleanly
        t_key = cache.make_key("tr", raw, cfg.provider, cfg.source_lang, cfg.target_lang, cfg.openai_model or "")
        cached_tr = cache.get_json(t_key)
        if cached_tr and cached_tr.get("translatedText"):
            cleaned_src = cached_tr.get("cleanedSourceText", raw)
            spoken_text = cached_tr["translatedText"].strip()
            was_translated = bool(cached_tr.get("wasTranslated", True))
            used_provider = cached_tr.get("provider", cfg.provider)
        else:
            try:
                tr = translate_text(raw, config=cfg, google_fetcher=google_fetcher)
            except Exception as err:
                raise HTTPException(status_code=502, detail=f"Translation failed: {err}")
            cleaned_src = tr.cleaned_source_text
            spoken_text = tr.translated_text.strip()
            was_translated = tr.was_translated
            used_provider = tr.provider
            cache.set_json(
                t_key,
                {
                    "sourceText": tr.source_text,
                    "cleanedSourceText": cleaned_src,
                    "translatedText": spoken_text,
                    "wasTranslated": was_translated,
                    "provider": used_provider,
                },
            )

        if not spoken_text:
            raise HTTPException(status_code=400, detail="Nothing speakable after cleaning text.")

        try:
            audio, sr = engine.synthesize(spoken_text, voice=req.voice)
        except Exception as err:
            raise HTTPException(status_code=500, detail=f"VieNeu-TTS synthesis failed: {err}")

        duration_ms = int(round((len(audio) / sr) * 1000)) if len(audio) and sr > 0 else 0
        word_timings = compute_word_timings(spoken_text, audio, sr)

        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()

        meta = {
            "sourceText": raw,
            "cleanedSourceText": cleaned_src,
            "translatedText": spoken_text,
            "wasTranslated": was_translated,
            "provider": used_provider,
            "voice": req.voice,
            "sampleRate": sr,
            "durationMs": duration_ms,
            "wordTimings": word_timings,
        }
        cache.set_json(full_key, meta)
        cache.set_bytes(full_key, wav_bytes)

        return {
            **meta,
            "audioBase64": base64.b64encode(wav_bytes).decode("ascii"),
            "cached": False,
            "latencyMs": int(round((time.perf_counter() - t0) * 1000)),
        }

    @app.post("/api/clone-voice")
    async def clone_voice(name: str = Form(...), file: UploadFile = File(...)):
        safe_name = re.sub(r"[^a-zA-Z0-9_\-]+", "_", (name or "").strip()).strip("_")
        if not safe_name:
            raise HTTPException(status_code=400, detail="Voice name must contain letters or numbers.")

        raw_bytes = await file.read()
        if not raw_bytes:
            raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

        try:
            data, sr = sf.read(io.BytesIO(raw_bytes), dtype="float32")
        except Exception as err:
            raise HTTPException(status_code=400, detail=f"Invalid WAV audio file: {err}")

        target_dir = getattr(engine, "primary_cloned_dir", Path(__file__).parent / "cloned_voices")
        target_dir.mkdir(parents=True, exist_ok=True)
        out_path = target_dir / f"{safe_name}.wav"
        sf.write(str(out_path), data, sr, format="WAV")
        return {
            "id": safe_name,
            "name": f"Giọng clone: {safe_name}",
            "sampleRate": sr,
            "durationSec": round(len(data) / sr, 2) if sr else 0,
        }

    return app


app = create_app(warm_up_on_start=os.environ.get("VIENEU_WARMUP", "1") == "1")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
