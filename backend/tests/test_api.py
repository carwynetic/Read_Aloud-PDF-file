import base64
import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from backend.app import create_app


class FakeTTSEngine:
    sample_rate = 48000
    backend_mode = "fake-test"

    def __init__(self, cloned_dir: Path):
        self.primary_cloned_dir = cloned_dir
        self.calls = 0

    def list_voices(self):
        return {
            "presets": [
                {"id": "hai_dang", "name": "Hải Đăng"},
                {"id": "truc_ly", "name": "Trúc Ly"},
            ],
            "cloned": [],
        }

    def synthesize(self, text: str, voice: str = "hai_dang"):
        self.calls += 1
        # Produce deterministic 0.6s 48kHz audio with speech envelope
        t = np.linspace(0, 0.5, int(self.sample_rate * 0.5), endpoint=False, dtype=np.float32)
        wave = 0.2 * np.sin(2 * np.pi * 240 * t)
        pad = np.zeros(int(self.sample_rate * 0.05), dtype=np.float32)
        audio = np.concatenate([pad, wave, pad])
        return audio, self.sample_rate


class TestBackendAPI(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp_path = Path(self._tmp.name)
        self.engine = FakeTTSEngine(cloned_dir=tmp_path / "cloned")
        self.app = create_app(
            tts_engine=self.engine,
            cache_dir=tmp_path / "cache",
            google_fetcher=lambda text, s, t: f"Bản dịch: {text}",
        )
        self.client = TestClient(self.app)

    def tearDown(self):
        self._tmp.cleanup()

    def test_health_endpoint_reports_ready_and_mode(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertTrue(data["ready"])
        self.assertEqual(data["tts_mode"], "fake-test")

    def test_health_endpoint_reports_warming_up_while_engine_loading(self):
        self.engine.is_warming_up = True
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "warming_up")
        self.assertFalse(data["ready"])

    def test_voices_endpoint_returns_preset_and_cloned_lists(self):
        resp = self.client.get("/api/voices")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["presets"]), 2)
        self.assertEqual(data["presets"][0]["id"], "hai_dang")

    def test_read_sentence_translates_synthesizes_and_returns_word_timings(self):
        resp = self.client.post(
            "/api/read-sentence",
            json={
                "text": "Simple framework for visual representations.",
                "voice": "hai_dang",
                "translate": True,
                "provider": "google",
            },
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("Bản dịch:", data["translatedText"])
        self.assertGreater(data["durationMs"], 500)
        self.assertGreater(len(data["wordTimings"]), 2)
        wav_bytes = base64.b64decode(data["audioBase64"])
        wav_data, sr = sf.read(io.BytesIO(wav_bytes))
        self.assertEqual(sr, 48000)
        self.assertGreater(len(wav_data), 10000)

    def test_read_sentence_rejects_blank_text(self):
        resp = self.client.post("/api/read-sentence", json={"text": "   "})
        self.assertEqual(resp.status_code, 400)

    def test_read_sentence_caches_repeat_requests(self):
        payload = {"text": "Contrastive learning works well.", "voice": "hai_dang"}
        r1 = self.client.post("/api/read-sentence", json=payload)
        r2 = self.client.post("/api/read-sentence", json=payload)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertFalse(r1.json()["cached"])
        self.assertTrue(r2.json()["cached"])
        self.assertEqual(self.engine.calls, 1)

    def test_clone_voice_saves_valid_wav_file(self):
        buf = io.BytesIO()
        sf.write(buf, np.zeros(4800, dtype=np.float32), 48000, format="WAV")
        resp = self.client.post(
            "/api/clone-voice",
            data={"name": "my_custom_voice"},
            files={"file": ("sample.wav", buf.getvalue(), "audio/wav")},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["id"], "my_custom_voice")
        self.assertTrue((self.engine.primary_cloned_dir / "my_custom_voice.wav").exists())


if __name__ == "__main__":
    unittest.main()
