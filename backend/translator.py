"""Academic PDF text cleaning and high-speed AI EN -> VI translation.

Supports automatic round-robin key rotation and failover across:
  1. Groq (openai/gpt-oss-20b) — ultra-fast (~350-800ms)
  2. Gemini (gemini-2.5-flash-lite) — natural Vietnamese + exact AI terminology
  3. Google Translate (zero-config fallback)
  4. Custom OpenAI-compatible / Ollama endpoint
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import httpx

GoogleFetcher = Callable[[str, str, str], str]
LlmFetcher = Callable[[str, "TranslationConfig"], str]

# Vietnamese-specific diacritic characters (beyond basic Latin)
_VI_DIACRITICS_RE = re.compile(
    r"[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]",
    re.IGNORECASE,
)

_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_BRACKET_CITE_RE = re.compile(r"\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]")
_PAREN_CITE_RE = re.compile(
    r"\(\s*(?:(?:e\.g\.|i\.e\.|see|cf\.)\s*,?\s*)?"
    r"[A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+(?:et\s+al\.|&\s+[A-Z][A-Za-zÀ-ÿ'’\-]+|and\s+[A-Z][A-Za-zÀ-ÿ'’\-]+))?"
    r"\s*,?\s*\d{4}[a-z]?"
    r"(?:\s*;\s*[^()]{3,80}\d{4}[a-z]?)*\s*\)"
)
_PDF_HYPHEN_BREAK_RE = re.compile(r"([A-Za-z]{2,})-\s+([a-z]{2,})")
_MULTI_SPACE_RE = re.compile(r"\s+")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,.;:!?])")

AI_TTS_SYSTEM_PROMPT = (
    "Bạn là chuyên gia AI/ML người Việt đang đọc và giải thích bài báo khoa học thành tiếng (TTS). "
    "Hãy dịch câu tiếng Anh sau sang tiếng Việt thật tự nhiên, dễ hiểu, mạch lạc, đúng ngữ cảnh học thuật.\n"
    "QUY TẮC BẮT BUỘC:\n"
    "1. GIỮ NGUYÊN tiếng Anh (KHÔNG dịch thô sang tiếng Việt) đối với các thuật ngữ chuyên ngành AI/ML/CS phổ biến như: "
    "supervised learning, semi-supervised learning, self-supervised learning, unsupervised learning, contrastive learning, "
    "reinforcement learning, batch size, epoch, data augmentation, fine-tuning, pre-training, backbone, embedding, "
    "feature, layer, transformer, attention, loss, gradient, benchmark, dataset, baseline, ablation, zero-shot, few-shot, "
    "overfitting, pipeline, framework, token, prompt, encoder, decoder, linear evaluation, memory bank, "
    "và tên mô hình/bộ dữ liệu (SimCLR, ResNet, ImageNet, AlexNet, BERT, GPT, ViT, CIFAR...).\n"
    "2. KHÔNG dùng bất kỳ ký tự markdown nào (không **in đậm**, không *in nghiêng*, không `code`, không ngoặc kép bọc cả câu).\n"
    "3. Không giải thích thêm, không mở đầu, không lặp lại câu gốc. Chỉ trả về DUY NHẤT câu dịch tiếng Việt sẵn sàng để đọc to.\n"
    "4. Chuyển nhẹ ký hiệu cho TTS đọc trôi chảy: ví dụ '100×' -> '100 lần', '76.5%' -> '76,5 phần trăm'."
)

# Persistent keep-alive HTTP client (reuses TLS sockets for low latency)
_HTTP_CLIENT: Optional[httpx.Client] = None
_HTTP_LOCK = threading.Lock()


def _get_http_client() -> httpx.Client:
    global _HTTP_CLIENT
    with _HTTP_LOCK:
        if _HTTP_CLIENT is None:
            _HTTP_CLIENT = httpx.Client(
                limits=httpx.Limits(max_keepalive_connections=16, max_connections=24),
                timeout=httpx.Timeout(12.0, connect=5.0),
            )
        return _HTTP_CLIENT


def load_local_env(env_path: Optional[Path] = None) -> None:
    """Load local .env file into os.environ (never overwrites existing vars)."""
    path = env_path or (Path(__file__).resolve().parent.parent / ".env")
    if not path.is_file():
        return
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and val:
                os.environ.setdefault(key, val)
    except OSError:
        pass


class KeyPool:
    """Thread-safe round-robin API key rotator with automatic cooldown on errors."""

    def __init__(self, keys: List[str]):
        cleaned = [k.strip() for k in keys if k and k.strip()]
        # Deduplicate while preserving order
        self._keys: List[str] = list(dict.fromkeys(cleaned))
        self._index: int = 0
        self._cooldowns: Dict[str, float] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_csv(cls, csv_value: str) -> "KeyPool":
        parts = [p.strip() for p in (csv_value or "").replace("\n", ",").split(",")]
        return cls(parts)

    def __len__(self) -> int:
        return len(self._keys)

    def next_key(self) -> Optional[str]:
        with self._lock:
            n = len(self._keys)
            if n == 0:
                return None
            now = time.monotonic()
            for _ in range(n):
                candidate = self._keys[self._index % n]
                self._index = (self._index + 1) % n
                if self._cooldowns.get(candidate, 0.0) <= now:
                    return candidate
            # If every key is on cooldown, pick the one whose cooldown expires soonest
            return min(self._keys, key=lambda k: self._cooldowns.get(k, 0.0))

    def mark_failed(self, key: str, cooldown_s: float = 60.0) -> None:
        with self._lock:
            self._cooldowns[key] = time.monotonic() + max(1.0, float(cooldown_s))


_POOLS_LOCK = threading.Lock()
_GROQ_POOL: Optional[KeyPool] = None
_GEMINI_POOL: Optional[KeyPool] = None


def get_key_pools() -> Tuple[KeyPool, KeyPool]:
    """Lazily initialize Groq and Gemini key pools from environment / .env."""
    global _GROQ_POOL, _GEMINI_POOL
    with _POOLS_LOCK:
        if _GROQ_POOL is None:
            load_local_env()
            _GROQ_POOL = KeyPool.from_csv(os.environ.get("GROQ_API_KEY", ""))
        if _GEMINI_POOL is None:
            load_local_env()
            _GEMINI_POOL = KeyPool.from_csv(os.environ.get("GEMINI_API_KEY", ""))
        return _GROQ_POOL, _GEMINI_POOL


@dataclass
class TranslationConfig:
    provider: str = "smart_ai"  # "smart_ai" | "groq" | "gemini" | "google" | "openai" | "passthrough"
    source_lang: str = "en"
    target_lang: str = "vi"
    groq_model: Optional[str] = None
    gemini_model: Optional[str] = None
    openai_base_url: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None
    timeout_s: float = 12.0


@dataclass
class TranslationResult:
    source_text: str
    cleaned_source_text: str
    translated_text: str
    was_translated: bool
    provider: str


def is_likely_vietnamese(text: str) -> bool:
    """Return True if text already contains strong Vietnamese diacritic density."""
    letters = re.findall(r"[A-Za-z\u00C0-\u1EF9]", text or "")
    if len(letters) < 6:
        return False
    vi_chars = _VI_DIACRITICS_RE.findall(text or "")
    return (len(vi_chars) / len(letters)) >= 0.08


def clean_text_for_tts(text: str) -> str:
    """Normalize PDF-extracted academic text so translation and TTS read fluently."""
    if not text:
        return ""

    out = text.replace("\u00ad", "")  # soft hyphen
    out = out.replace("\ufb01", "fi").replace("\ufb02", "fl")  # PDF ligatures
    out = _PDF_HYPHEN_BREAK_RE.sub(r"\1\2", out)
    out = _URL_RE.sub("", out)
    out = _PAREN_CITE_RE.sub("", out)
    out = _BRACKET_CITE_RE.sub("", out)
    out = re.sub(r"\(\s*\)", "", out)
    out = _MULTI_SPACE_RE.sub(" ", out).strip()
    out = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", out)
    return out.strip()


def clean_llm_output_for_tts(text: str) -> str:
    """Remove accidental markdown/quotes and normalize symbols so VieNeu-TTS speaks smoothly."""
    if not text:
        return ""

    out = text.strip()
    # Strip enclosing quotes if LLM wrapped the entire sentence
    if len(out) >= 2 and out[0] in ('"', "“", "'") and out[-1] in ('"', "”", "'"):
        out = out[1:-1].strip()
    # Strip markdown bold/italic/code markers
    out = re.sub(r"\*\*(.+?)\*\*", r"\1", out)
    out = re.sub(r"\*(.+?)\*", r"\1", out)
    out = out.replace("`", "").replace("**", "").replace("*", "")
    # Normalize common numeric expressions for natural Vietnamese TTS reading
    out = re.sub(r"(\d+)\s*(?:×|[xX](?=\s|$|[,.;:!?]))", r"\1 lần", out)
    out = re.sub(r"(\d+)\.(\d+)\s*%", r"\1,\2 phần trăm", out)
    out = re.sub(r"(\d+)\s*%", r"\1 phần trăm", out)
    out = _MULTI_SPACE_RE.sub(" ", out).strip()
    return out


def fetch_groq_translate(text: str, config: TranslationConfig) -> str:
    """Translate via Groq API with automatic round-robin rotation across key pool."""
    groq_pool, _ = get_key_pools()
    if len(groq_pool) == 0:
        raise RuntimeError("No GROQ_API_KEY configured.")

    model = config.groq_model or os.environ.get("GROQ_MODEL") or "openai/gpt-oss-20b"
    client = _get_http_client()
    attempts = min(3, len(groq_pool))
    last_err: Optional[Exception] = None

    for _ in range(attempts):
        key = groq_pool.next_key()
        if not key:
            break
        body = {
            "model": model,
            "temperature": 0.15,
            "max_tokens": 320,
            "messages": [
                {"role": "system", "content": AI_TTS_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
        }
        if "gpt-oss" in model:
            body["reasoning_effort"] = "low"
        elif "qwen" in model:
            body["reasoning_effort"] = "none"

        try:
            resp = client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=body,
                timeout=config.timeout_s,
            )
            if resp.status_code in (401, 403, 429) or resp.status_code >= 500:
                groq_pool.mark_failed(key, cooldown_s=90.0 if resp.status_code == 429 else 300.0)
                last_err = RuntimeError(f"Groq HTTP {resp.status_code}")
                continue
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            cleaned = clean_llm_output_for_tts(content)
            if cleaned:
                return cleaned
        except Exception as err:
            groq_pool.mark_failed(key, cooldown_s=45.0)
            last_err = err

    raise RuntimeError(f"Groq translation failed after {attempts} attempt(s): {last_err}")


def fetch_gemini_translate(text: str, config: TranslationConfig) -> str:
    """Translate via Gemini API with automatic round-robin rotation across key pool."""
    _, gemini_pool = get_key_pools()
    if len(gemini_pool) == 0:
        raise RuntimeError("No GEMINI_API_KEY configured.")

    model = config.gemini_model or os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash-lite"
    client = _get_http_client()
    attempts = min(3, len(gemini_pool))
    last_err: Optional[Exception] = None

    for _ in range(attempts):
        key = gemini_pool.next_key()
        if not key:
            break
        body = {
            "systemInstruction": {"parts": [{"text": AI_TTS_SYSTEM_PROMPT}]},
            "contents": [{"parts": [{"text": text}]}],
            "generationConfig": {"temperature": 0.15, "maxOutputTokens": 320},
        }
        try:
            resp = client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                params={"key": key},
                json=body,
                timeout=config.timeout_s,
            )
            if resp.status_code in (401, 403, 429) or resp.status_code >= 500:
                gemini_pool.mark_failed(key, cooldown_s=90.0 if resp.status_code == 429 else 300.0)
                last_err = RuntimeError(f"Gemini HTTP {resp.status_code}")
                continue
            resp.raise_for_status()
            candidates = resp.json().get("candidates") or []
            parts = candidates[0]["content"]["parts"] if candidates else []
            content = "".join(p.get("text", "") for p in parts)
            cleaned = clean_llm_output_for_tts(content)
            if cleaned:
                return cleaned
        except Exception as err:
            gemini_pool.mark_failed(key, cooldown_s=45.0)
            last_err = err

    raise RuntimeError(f"Gemini translation failed after {attempts} attempt(s): {last_err}")


def fetch_google_translate(
    text: str,
    source_lang: str = "en",
    target_lang: str = "vi",
    timeout_s: float = 12.0,
) -> str:
    """Translate text via Google Translate's free public endpoint."""
    url = "https://translate.googleapis.com/translate_a/single"
    params = {
        "client": "gtx",
        "sl": source_lang or "auto",
        "tl": target_lang or "vi",
        "dt": "t",
        "q": text,
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    client = _get_http_client()
    resp = client.get(url, params=params, headers=headers, timeout=timeout_s)
    resp.raise_for_status()
    payload = resp.json()

    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        return text

    parts = [seg[0] for seg in payload[0] if isinstance(seg, list) and seg and seg[0]]
    translated = "".join(parts).strip()
    return translated or text


def fetch_openai_translate(text: str, config: TranslationConfig) -> str:
    """Translate text using an OpenAI-compatible Chat Completions endpoint."""
    base_url = (
        config.openai_base_url
        or os.environ.get("READALOUD_LLM_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    api_key = config.openai_api_key or os.environ.get("READALOUD_LLM_API_KEY") or ""
    model = config.openai_model or os.environ.get("READALOUD_LLM_MODEL") or "gpt-4o-mini"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = {
        "model": model,
        "temperature": 0.15,
        "messages": [
            {"role": "system", "content": AI_TTS_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    }

    client = _get_http_client()
    resp = client.post(f"{base_url}/chat/completions", headers=headers, json=body, timeout=config.timeout_s)
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return clean_llm_output_for_tts(content) or text


def translate_text(
    text: str,
    config: Optional[TranslationConfig] = None,
    google_fetcher: Optional[GoogleFetcher] = None,
    groq_fetcher: Optional[LlmFetcher] = None,
    gemini_fetcher: Optional[LlmFetcher] = None,
) -> TranslationResult:
    """Clean and translate PDF text with terminology preservation and smart failover."""
    cfg = config or TranslationConfig()
    cleaned = clean_text_for_tts(text)

    if not cleaned:
        return TranslationResult(
            source_text=text,
            cleaned_source_text="",
            translated_text="",
            was_translated=False,
            provider=cfg.provider,
        )

    if cfg.provider == "passthrough" or is_likely_vietnamese(cleaned):
        return TranslationResult(
            source_text=text,
            cleaned_source_text=cleaned,
            translated_text=cleaned,
            was_translated=False,
            provider="passthrough",
        )

    run_groq = groq_fetcher or fetch_groq_translate
    run_gemini = gemini_fetcher or fetch_gemini_translate
    run_google = google_fetcher or (
        lambda q, s, t: fetch_google_translate(q, s, t, timeout_s=cfg.timeout_s)
    )

    if cfg.provider == "smart_ai":
        for name, fn in (("groq", run_groq), ("gemini", run_gemini)):
            try:
                translated = clean_llm_output_for_tts(fn(cleaned, cfg))
                if translated:
                    return TranslationResult(
                        source_text=text,
                        cleaned_source_text=cleaned,
                        translated_text=translated,
                        was_translated=True,
                        provider=name,
                    )
            except Exception:
                continue
        # Last-resort fallback to Google Translate
        translated = run_google(cleaned, cfg.source_lang, cfg.target_lang)
        return TranslationResult(
            source_text=text,
            cleaned_source_text=cleaned,
            translated_text=translated,
            was_translated=True,
            provider="google-fallback",
        )

    if cfg.provider == "groq":
        try:
            translated = clean_llm_output_for_tts(run_groq(cleaned, cfg))
            return TranslationResult(
                source_text=text,
                cleaned_source_text=cleaned,
                translated_text=translated,
                was_translated=True,
                provider="groq",
            )
        except Exception:
            translated = clean_llm_output_for_tts(run_gemini(cleaned, cfg))
            return TranslationResult(
                source_text=text,
                cleaned_source_text=cleaned,
                translated_text=translated,
                was_translated=True,
                provider="gemini-fallback",
            )

    if cfg.provider == "gemini":
        try:
            translated = clean_llm_output_for_tts(run_gemini(cleaned, cfg))
            return TranslationResult(
                source_text=text,
                cleaned_source_text=cleaned,
                translated_text=translated,
                was_translated=True,
                provider="gemini",
            )
        except Exception:
            translated = clean_llm_output_for_tts(run_groq(cleaned, cfg))
            return TranslationResult(
                source_text=text,
                cleaned_source_text=cleaned,
                translated_text=translated,
                was_translated=True,
                provider="groq-fallback",
            )

    if cfg.provider == "openai":
        translated = fetch_openai_translate(cleaned, cfg)
        return TranslationResult(
            source_text=text,
            cleaned_source_text=cleaned,
            translated_text=translated,
            was_translated=True,
            provider="openai",
        )

    translated = run_google(cleaned, cfg.source_lang, cfg.target_lang)
    return TranslationResult(
        source_text=text,
        cleaned_source_text=cleaned,
        translated_text=translated,
        was_translated=True,
        provider="google",
    )
