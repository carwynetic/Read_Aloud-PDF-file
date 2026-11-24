import tempfile
import unittest
from pathlib import Path

from backend.cache import DiskLRUCache


class TestCache(unittest.TestCase):
    def test_stores_and_retrieves_translation_and_audio_bytes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache = DiskLRUCache(Path(tmpdir), max_items=4)
            key = cache.make_key("hello world", "hai_dang", "google")
            self.assertIsNone(cache.get_json(key))

            cache.set_json(key, {"translated": "xin chào thế giới"})
            self.assertEqual(cache.get_json(key), {"translated": "xin chào thế giới"})

            cache.set_bytes(key, b"RIFF1234WAVE")
            self.assertEqual(cache.get_bytes(key), b"RIFF1234WAVE")

    def test_evicts_oldest_entries_when_exceeding_max_items(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache = DiskLRUCache(Path(tmpdir), max_items=2)
            k1 = cache.make_key("s1", "v1", "google")
            k2 = cache.make_key("s2", "v1", "google")
            k3 = cache.make_key("s3", "v1", "google")

            cache.set_json(k1, {"n": 1})
            cache.set_json(k2, {"n": 2})
            # Touch k1 so k2 becomes least recently used
            _ = cache.get_json(k1)
            cache.set_json(k3, {"n": 3})

            self.assertIsNotNone(cache.get_json(k1))
            self.assertIsNone(cache.get_json(k2))
            self.assertIsNotNone(cache.get_json(k3))


if __name__ == "__main__":
    unittest.main()
