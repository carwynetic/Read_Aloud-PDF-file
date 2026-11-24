"""Academic PDF text cleaning and pluggable EN -> VI translation."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

GoogleFetcher = Callable[[str, str, str], str]

# Vietnamese-specific diacritic characters (beyond basic Latin)
_VI_DIACRITICS_RE = re.compile(
    r"[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]",
    re.IGNORECASE,
)

# Common academic citation patterns:
# - Parenthetical author-year: (Hinton et al., 2006; Kingma & Welling, 2013)
# - Numeric brackets: [12], [1, 2, 5-8]
_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_BRACKET_CITE_RE = re.compile(r"\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]")
_PAREN_CITE_RE = re.compile(
    r"\(\s*(?:(?:e\.g\.|i\.e\.|see|cf\.)\s*,?\s*)?"
    r"[A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+(?:et\s+al\.|&\s+[A-Z][A-Za-zÀ-ÿ'’\-]+|and\s+[A-Z][A-Za-zÀ-ÿ'’\-]+))?"
    r"\s*,?\s*\d{4}[a-z]?"
    r"(?:\s*;\s*[^()]{3,80}\d{4}[a-z]?)*\s*\)"
)
# PDF line-break hyphen followed by whitespace and lowercase continuation ("dis- criminative" -> "discriminative")
_PDF_HYPHEN_BREAK_RE = re.compile(r"([A-Za-z]{2,})-\s+([a-z]{2,})")
_MULTI_SPACE_RE = re.compile(r"\s+")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,.;:!?])")


@dataclass
class TranslationConfig:
    provider: str = "google"  # "google" | "openai" | "passthrough"
    source_lang: str = "en"
    target_lang: str = "vi"
    openai_base_url: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None
    timeout_s: float = 15.0


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
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.get(url, params=params, headers=headers)
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
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Bạn là biên dịch viên học thuật Anh-Việt chuyên đọc thành tiếng (TTS). "
                    "Hãy dịch chính xác, tự nhiên, mượt mà sang tiếng Việt để đọc to. "
                    "Giữ tên riêng/thuật ngữ nổi tiếng khi cần, không thêm giải thích, chỉ trả về câu đã dịch."
                ),
            },
            {"role": "user", "content": text},
        ],
    }

    with httpx.Client(timeout=config.timeout_s) as client:
        resp = client.post(f"{base_url}/chat/completions", headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()

    content = data["choices"][0]["message"]["content"].strip()
    return content or text


def translate_text(
    text: str,
    config: Optional[TranslationConfig] = None,
    google_fetcher: Optional[GoogleFetcher] = None,
) -> TranslationResult:
    """Clean and translate PDF text according to config."""
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

    if cfg.provider == "openai":
        translated = fetch_openai_translate(cleaned, cfg)
        return TranslationResult(
            source_text=text,
            cleaned_source_text=cleaned,
            translated_text=translated,
            was_translated=True,
            provider="openai",
        )

    fetcher = google_fetcher or (
        lambda q, s, t: fetch_google_translate(q, s, t, timeout_s=cfg.timeout_s)
    )
    translated = fetcher(cleaned, cfg.source_lang, cfg.target_lang)
    return TranslationResult(
        source_text=text,
        cleaned_source_text=cleaned,
        translated_text=translated,
        was_translated=True,
        provider="google",
    )
