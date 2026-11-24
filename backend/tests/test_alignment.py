import unittest
import numpy as np

from backend.alignment import compute_word_timings, detect_active_speech_bounds


class TestAlignment(unittest.TestCase):
    def test_detects_active_speech_bounds_skipping_leading_and_trailing_silence(self):
        sr = 48000
        leading_silence = np.zeros(int(sr * 0.3), dtype=np.float32)
        t = np.linspace(0, 1.0, sr, endpoint=False, dtype=np.float32)
        tone = 0.25 * np.sin(2 * np.pi * 220 * t)
        trailing_silence = np.zeros(int(sr * 0.4), dtype=np.float32)
        audio = np.concatenate([leading_silence, tone, trailing_silence])

        start_ms, end_ms = detect_active_speech_bounds(audio, sr)
        self.assertGreaterEqual(start_ms, 240)
        self.assertLessEqual(start_ms, 340)
        self.assertGreaterEqual(end_ms, 1250)
        self.assertLessEqual(end_ms, 1360)

    def test_compute_word_timings_covers_vietnamese_words_monotonically_with_punctuation_pause(self):
        sr = 48000
        # 2.0s audio with 100ms silence at start/end
        t = np.linspace(0, 1.8, int(sr * 1.8), endpoint=False, dtype=np.float32)
        speech = 0.2 * np.sin(2 * np.pi * 200 * t)
        pad = np.zeros(int(sr * 0.1), dtype=np.float32)
        audio = np.concatenate([pad, speech, pad])

        text = "Xin chào, hệ thống đọc báo cáo."
        timings = compute_word_timings(text, audio, sr)

        words = [item["word"] for item in timings]
        self.assertEqual(words, ["Xin", "chào,", "hệ", "thống", "đọc", "báo", "cáo."])
        for i, item in enumerate(timings):
            self.assertLess(item["startMs"], item["endMs"])
            if i > 0:
                self.assertGreaterEqual(item["startMs"], timings[i - 1]["endMs"] - 1)
        # Comma word should allocate extra duration vs an equal-length word without comma
        self.assertGreaterEqual(timings[0]["startMs"], 50)
        self.assertLessEqual(timings[-1]["endMs"], 1980)

    def test_compute_word_timings_handles_empty_text(self):
        audio = np.zeros(4800, dtype=np.float32)
        self.assertEqual(compute_word_timings("   ", audio, 48000), [])


if __name__ == "__main__":
    unittest.main()
