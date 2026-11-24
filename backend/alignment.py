"""Audio energy envelope detection and Vietnamese word-timing alignment."""

from __future__ import annotations

import re
from typing import Dict, List, Tuple

import numpy as np

_PAUSE_WEIGHTS = {
    ",": 1.6,
    ";": 2.0,
    ":": 1.8,
    "—": 1.6,
    "–": 1.4,
    ".": 2.6,
    "!": 2.6,
    "?": 2.6,
    "…": 2.4,
}


def detect_active_speech_bounds(
    audio: np.ndarray,
    sample_rate: int,
    frame_ms: float = 20.0,
    threshold_ratio: float = 0.06,
) -> Tuple[int, int]:
    """Detect active speech start and end timestamps (ms) from WAV RMS energy."""
    if audio is None or len(audio) == 0 or sample_rate <= 0:
        return 0, 0

    mono = np.asarray(audio, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=1)

    total_ms = int(round((len(mono) / sample_rate) * 1000))
    frame_len = max(1, int(round(sample_rate * (frame_ms / 1000.0))))
    num_frames = max(1, len(mono) // frame_len)

    trimmed = mono[: num_frames * frame_len].reshape(num_frames, frame_len)
    rms = np.sqrt(np.mean(trimmed * trimmed, axis=1))
    peak = float(np.max(rms)) if rms.size else 0.0

    if peak < 1e-5:
        return 0, total_ms

    threshold = max(peak * threshold_ratio, 1e-4)
    active = np.flatnonzero(rms >= threshold)
    if active.size == 0:
        return 0, total_ms

    start_ms = int(round(active[0] * frame_ms))
    end_ms = min(total_ms, int(round((active[-1] + 1) * frame_ms)))
    if end_ms <= start_ms:
        return 0, total_ms
    return start_ms, end_ms


def _word_weight(token: str) -> float:
    """Compute acoustic duration weight for a Vietnamese/English word token."""
    stripped = re.sub(r"[^\w\u00C0-\u1EF9]+", "", token, flags=re.UNICODE)
    base = max(1.0, float(len(stripped)) * 0.72 + 1.15)
    trailing = token[-1] if token else ""
    pause = _PAUSE_WEIGHTS.get(trailing, 0.0)
    return base + pause


def compute_word_timings(
    text: str,
    audio: np.ndarray,
    sample_rate: int,
) -> List[Dict[str, object]]:
    """Map whitespace-separated words to monotonic [startMs, endMs] intervals."""
    tokens = [tok for tok in (text or "").strip().split() if tok]
    if not tokens:
        return []

    total_ms = int(round((len(audio) / sample_rate) * 1000)) if len(audio) and sample_rate > 0 else 0
    if total_ms <= 0:
        return []

    start_ms, end_ms = detect_active_speech_bounds(audio, sample_rate)
    speech_span = max(len(tokens), end_ms - start_ms)

    weights = [_word_weight(tok) for tok in tokens]
    weight_sum = sum(weights) or float(len(tokens))

    timings: List[Dict[str, object]] = []
    cursor = float(start_ms)

    for idx, (tok, w) in enumerate(zip(tokens, weights)):
        duration = (w / weight_sum) * speech_span
        next_cursor = float(end_ms) if idx == len(tokens) - 1 else cursor + duration
        w_start = int(round(cursor))
        w_end = max(w_start + 1, int(round(next_cursor)))
        timings.append(
            {
                "index": idx,
                "word": tok,
                "startMs": w_start,
                "endMs": w_end,
            }
        )
        cursor = next_cursor

    return timings
