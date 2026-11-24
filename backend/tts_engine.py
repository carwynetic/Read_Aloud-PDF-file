"""Hybrid VieNeu-TTS Engine.

Reuses an already-running OpenMAIC VieNeu-TTS server on port 8000 if reachable
to save RAM, or falls back to loading VieNeu-TTS v3 Turbo (int8 ONNX/CPU) directly
in-process using the local package installation.
"""

from __future__ import annotations

import io
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np
import soundfile as sf

DEFAULT_VOICE = "Hải Đăng"

VOICE_MAP: Dict[str, str] = {
    "hai_dang": "Hải Đăng",
    "haidang": "Hải Đăng",
    "hải đăng": "Hải Đăng",
    "truc_ly": "Trúc Ly",
    "trucly": "Trúc Ly",
    "trúc ly": "Trúc Ly",
    "thien_minh": "Thiện Minh",
    "thienminh": "Thiện Minh",
    "thiện minh": "Thiện Minh",
    "mai_anh": "Mai Anh",
    "maianh": "Mai Anh",
    "mai anh": "Mai Anh",
    "thuy_dung": "Thùy Dung",
    "thuydung": "Thùy Dung",
    "thùy dung": "Thùy Dung",
    "quang_son": "Quang Sơn",
    "quangson": "Quang Sơn",
    "quang sơn": "Quang Sơn",
    "ngoc_tran": "Ngọc Trân",
    "ngoctran": "Ngọc Trân",
    "ngọc trân": "Ngọc Trân",
    "xuan_vinh": "Xuân Vĩnh",
    "minh_duc": "Minh Đức",
    "adam": "Adam",
}

FALLBACK_PRESETS = [
    {"id": "hai_dang", "name": "Hải Đăng (Nam - Bắc)"},
    {"id": "truc_ly", "name": "Trúc Ly (Nữ - Nam)"},
    {"id": "mai_anh", "name": "Mai Anh (Nữ - Bắc)"},
    {"id": "thien_minh", "name": "Thiện Minh (Nam - Nam)"},
    {"id": "thuy_dung", "name": "Thùy Dung (Nữ)"},
    {"id": "quang_son", "name": "Quang Sơn (Nam)"},
    {"id": "ngoc_tran", "name": "Ngọc Trân (Nữ)"},
]


class HybridVieNeuEngine:
    """Thread-safe VieNeu-TTS engine supporting OpenMAIC proxy or local ONNX/CPU load."""

    def __init__(
        self,
        upstream_url: Optional[str] = None,
        cloned_dirs: Optional[List[Path]] = None,
        precision: str = "int8",
    ):
        self.upstream_url = (
            upstream_url
            or os.environ.get("VIENEU_UPSTREAM_URL")
            or "http://127.0.0.1:8000"
        ).rstrip("/")
        self.precision = os.environ.get("VIENEU_PRECISION", precision)
        self.sample_rate = 48000
        self._tts_model: Any = None
        self._lock = threading.Lock()
        self._upstream_ok_until: float = 0.0
        self._backend_mode = "auto"
        self.is_warming_up: bool = False
        self.warmup_error: Optional[str] = None

        local_cloned = Path(__file__).parent / "cloned_voices"
        local_cloned.mkdir(parents=True, exist_ok=True)
        openmaic_cloned = Path(r"D:\Vscode-luyện code\OpenMAIC\vieneu-server\cloned_voices")

        self.cloned_dirs: List[Path] = cloned_dirs if cloned_dirs is not None else [
            local_cloned,
            openmaic_cloned,
        ]
        self.primary_cloned_dir = self.cloned_dirs[0]

    @property
    def backend_mode(self) -> str:
        if self._tts_model is not None:
            return f"local-v3turbo-{self.precision}"
        if self._is_upstream_alive():
            return f"proxy-openmaic ({self.upstream_url})"
        return "lazy-unloaded"

    def _is_upstream_alive(self) -> bool:
        now = time.monotonic()
        if now < self._upstream_ok_until:
            return True
        try:
            with httpx.Client(timeout=1.2) as client:
                resp = client.get(f"{self.upstream_url}/health")
                if resp.status_code == 200:
                    self._upstream_ok_until = now + 15.0
                    return True
        except Exception:
            pass
        return False

    def _find_cloned_voice_path(self, voice_key: str) -> Optional[Path]:
        clean = Path(voice_key).name
        candidates = [clean, f"{clean}.wav"]
        if clean.lower() in ("my_voice", "my-voice", "cloned", "me"):
            candidates.append("my_voice.wav")
        for directory in self.cloned_dirs:
            if not directory.exists():
                continue
            for name in candidates:
                candidate = directory / name
                if candidate.is_file() and candidate.suffix.lower() == ".wav":
                    return candidate
        return None

    @staticmethod
    def _has_local_hf_cache() -> bool:
        hf_hub = Path.home() / ".cache" / "huggingface" / "hub"
        return (hf_hub / "models--pnnbao-ump--VieNeu-TTS-v3-Turbo").exists()

    def _get_local_model(self):
        with self._lock:
            if self._tts_model is None:
                from vieneu import Vieneu

                print(f"[VieNeu-ReadAloud] Loading VieNeu-TTS v3 Turbo ({self.precision})...")
                t0 = time.time()
                prev_offline = os.environ.get("HF_HUB_OFFLINE")
                used_offline = False
                if prev_offline is None and self._has_local_hf_cache():
                    os.environ["HF_HUB_OFFLINE"] = "1"
                    used_offline = True
                try:
                    self._tts_model = Vieneu(mode="v3turbo", precision=self.precision)
                except Exception:
                    if used_offline:
                        os.environ.pop("HF_HUB_OFFLINE", None)
                        self._tts_model = Vieneu(mode="v3turbo", precision=self.precision)
                    else:
                        raise
                finally:
                    if used_offline:
                        if prev_offline is None:
                            os.environ.pop("HF_HUB_OFFLINE", None)
                        else:
                            os.environ["HF_HUB_OFFLINE"] = prev_offline

                self.sample_rate = getattr(self._tts_model, "sample_rate", 48000)
                print(
                    f"[VieNeu-ReadAloud] Loaded VieNeu-TTS in {time.time() - t0:.2f}s (sr={self.sample_rate})."
                )
            return self._tts_model

    def warm_up(self) -> None:
        """Pre-warm local model in background only if OpenMAIC upstream server is not running."""
        if self._is_upstream_alive():
            print(f"[VieNeu-ReadAloud] Detected running OpenMAIC VieNeu server at {self.upstream_url} (proxy mode).")
            return
        self.is_warming_up = True
        self.warmup_error = None
        try:
            tts = self._get_local_model()
            with self._lock:
                _ = tts.infer("Hệ thống đọc tài liệu đã sẵn sàng.", voice=DEFAULT_VOICE, apply_watermark=False)
            print("[VieNeu-ReadAloud] VieNeu-TTS warm-up complete. Ready to speak!")
        except Exception as err:
            self.warmup_error = str(err)
            print(f"[VieNeu-ReadAloud] Warm-up warning: {err}")
        finally:
            self.is_warming_up = False

    def list_voices(self) -> Dict[str, List[Dict[str, str]]]:
        presets: List[Dict[str, str]] = []
        cloned: List[Dict[str, str]] = []
        seen_cloned = set()

        if self._tts_model is None and self._is_upstream_alive():
            try:
                with httpx.Client(timeout=4.0) as client:
                    resp = client.get(f"{self.upstream_url}/v1/voices")
                    if resp.status_code == 200:
                        data = resp.json()
                        presets = data.get("presets") or []
                        for c in data.get("cloned") or []:
                            cid = c.get("id")
                            if cid and cid not in seen_cloned:
                                seen_cloned.add(cid)
                                cloned.append({"id": cid, "name": c.get("name", f"Cloned: {cid}")})
            except Exception:
                pass

        if not presets:
            if self._tts_model is not None and hasattr(self._tts_model, "list_preset_voices"):
                try:
                    presets = [
                        {"id": v[1], "name": v[0]}
                        for v in self._tts_model.list_preset_voices()
                    ]
                except Exception:
                    presets = list(FALLBACK_PRESETS)
            else:
                presets = list(FALLBACK_PRESETS)

        for directory in self.cloned_dirs:
            if not directory.exists():
                continue
            for wav_file in sorted(directory.glob("*.wav")):
                if wav_file.stem not in seen_cloned:
                    seen_cloned.add(wav_file.stem)
                    cloned.append(
                        {
                            "id": wav_file.stem,
                            "name": f"Giọng clone: {wav_file.stem}",
                        }
                    )

        return {"presets": presets, "cloned": cloned}

    def synthesize(self, text: str, voice: str = "hai_dang") -> Tuple[np.ndarray, int]:
        """Synthesize Vietnamese text to (float32 waveform, sample_rate)."""
        cleaned = (text or "").strip()
        if not cleaned:
            raise ValueError("Text input cannot be empty.")

        voice_key = (voice or "hai_dang").strip()
        cloned_path = self._find_cloned_voice_path(voice_key)

        # Prefer OpenMAIC proxy when running and voice isn't exclusively local-cloned
        if self._tts_model is None and self._is_upstream_alive():
            try:
                with httpx.Client(timeout=60.0) as client:
                    resp = client.post(
                        f"{self.upstream_url}/v1/audio/speech",
                        json={
                            "model": "vieneu-tts",
                            "input": cleaned,
                            "voice": voice_key,
                            "response_format": "wav",
                        },
                    )
                    if resp.status_code == 200:
                        audio, sr = sf.read(io.BytesIO(resp.content), dtype="float32")
                        return np.asarray(audio, dtype=np.float32), int(sr)
            except Exception as err:
                print(f"[VieNeu-ReadAloud] Upstream proxy failed ({err}), falling back to local engine.")

        tts = self._get_local_model()
        target_preset = VOICE_MAP.get(voice_key.lower(), voice_key) or DEFAULT_VOICE

        with self._lock:
            try:
                if cloned_path is not None:
                    audio = tts.infer(cleaned, ref_audio=str(cloned_path), apply_watermark=False)
                else:
                    audio = tts.infer(cleaned, voice=target_preset, apply_watermark=False)
            except Exception:
                audio = tts.infer(cleaned, voice=DEFAULT_VOICE, apply_watermark=False)

        sr = int(getattr(tts, "sample_rate", 48000))
        return np.asarray(audio, dtype=np.float32), sr
