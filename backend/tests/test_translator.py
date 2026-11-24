import unittest

from backend.translator import clean_text_for_tts, translate_text, TranslationConfig


class TestTranslator(unittest.TestCase):
    def test_clean_text_for_tts_removes_citations_urls_and_normalizes_whitespace(self):
        raw = "Generative approaches learn pixels (Hinton et al., 2006; Kingma & Welling, 2013) see https://github.com/google-research/simclr [12, 14]   now."
        cleaned = clean_text_for_tts(raw)
        self.assertNotIn("https://", cleaned)
        self.assertNotIn("[12, 14]", cleaned)
        self.assertNotIn("Hinton et al.", cleaned)
        self.assertIn("Generative approaches learn pixels", cleaned)
        self.assertNotIn("   ", cleaned)

    def test_clean_text_for_tts_joins_hyphenated_pdf_line_breaks(self):
        raw = "dis- criminative represen- tations in self-supervised learning."
        cleaned = clean_text_for_tts(raw)
        self.assertIn("discriminative", cleaned)
        self.assertIn("representations", cleaned)
        self.assertIn("self-supervised", cleaned)

    def test_translate_text_skips_translation_when_input_is_already_vietnamese(self):
        vi = "Phương pháp học tương phản giúp cải thiện biểu diễn hình ảnh rất hiệu quả."
        result = translate_text(vi, config=TranslationConfig(provider="passthrough"))
        self.assertEqual(result.translated_text, vi)
        self.assertFalse(result.was_translated)

    def test_translate_text_uses_custom_http_fetcher_for_google_provider(self):
        called = {}

        def fake_google_fetch(text: str, source_lang: str, target_lang: str) -> str:
            called["text"] = text
            called["src"] = source_lang
            called["tgt"] = target_lang
            return "Các phương pháp học tương phản rất đơn giản."

        result = translate_text(
            "Contrastive learning approaches are very simple.",
            config=TranslationConfig(provider="google", source_lang="en", target_lang="vi"),
            google_fetcher=fake_google_fetch,
        )
        self.assertEqual(result.translated_text, "Các phương pháp học tương phản rất đơn giản.")
        self.assertTrue(result.was_translated)
        self.assertEqual(called["src"], "en")
        self.assertEqual(called["tgt"], "vi")


if __name__ == "__main__":
    unittest.main()
