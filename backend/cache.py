"""Thread-safe disk-backed LRU cache for translations and synthesized WAV audio."""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional


class DiskLRUCache:
    """Persists JSON metadata and binary WAV blobs on disk with LRU eviction."""

    def __init__(self, cache_dir: Path, max_items: int = 300):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_items = max(1, int(max_items))
        self._lock = threading.Lock()
        self._order: OrderedDict[str, None] = OrderedDict()
        self._load_existing()

    def _load_existing(self) -> None:
        files = sorted(
            self.cache_dir.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
        )
        for path in files:
            self._order[path.stem] = None
        self._evict_locked()

    @staticmethod
    def make_key(*parts: str) -> str:
        raw = "\x1f".join(str(p or "") for p in parts)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]

    def _json_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.json"

    def _bin_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.bin"

    def _touch_locked(self, key: str) -> None:
        if key in self._order:
            self._order.move_to_end(key)
        else:
            self._order[key] = None

    def _evict_locked(self) -> None:
        while len(self._order) > self.max_items:
            oldest_key, _ = self._order.popitem(last=False)
            for path in (self._json_path(oldest_key), self._bin_path(oldest_key)):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    def get_json(self, key: str) -> Optional[Any]:
        with self._lock:
            path = self._json_path(key)
            if not path.exists():
                self._order.pop(key, None)
                return None
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            self._touch_locked(key)
            return data

    def set_json(self, key: str, value: Any) -> None:
        with self._lock:
            path = self._json_path(key)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
            self._touch_locked(key)
            self._evict_locked()

    def get_bytes(self, key: str) -> Optional[bytes]:
        with self._lock:
            path = self._bin_path(key)
            if not path.exists():
                return None
            try:
                data = path.read_bytes()
            except OSError:
                return None
            self._touch_locked(key)
            return data

    def set_bytes(self, key: str, payload: bytes) -> None:
        with self._lock:
            path = self._bin_path(key)
            tmp = path.with_suffix(".bin.tmp")
            tmp.write_bytes(payload)
            tmp.replace(path)
            self._touch_locked(key)
            self._evict_locked()
