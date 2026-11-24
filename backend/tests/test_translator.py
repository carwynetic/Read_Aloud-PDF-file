import unittest

from backend.translator import (
    KeyPool,
    TranslationConfig,
    clean_llm_output_for_tts,
    clean_text_for_tts,
    translate_text,
)


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

    def test_key_pool_rotates_and_skips_cooled_down_keys(self):
        pool = KeyPool.from_csv("k1, k2 , k3")
        self.assertEqual(pool.next_key(), "k1")
        self.assertEqual(pool.next_key(), "k2")
        pool.mark_failed("k3", cooldown_s=60)
        self.assertEqual(pool.next_key(), "k1")

    def test_clean_llm_output_strips_markdown_and_normalizes_for_tts(self):
        raw = '  "Mô hình **SimCLR** cải thiện `batch size` và *epoch* nhanh hơn 100× đạt 76.5%."  '
        cleaned = clean_llm_output_for_tts(raw)
        self.assertNotIn("**", cleaned)
        self.assertNotIn("`", cleaned)
        self.assertNotIn("*", cleaned)
        self.assertIn("batch size", cleaned)
        self.assertIn("epoch", cleaned)
        self.assertIn("100 lần", cleaned)
        self.assertIn("76,5 phần trăm", cleaned)

    def test_smart_ai_fails_over_from_groq_to_gemini_to_google(self):
        calls = []

        def fail_groq(text, cfg):
            calls.append("groq")
            raise RuntimeError("429 rate limit")

        def ok_gemini(text, cfg):
            calls.append("gemini")
            return "Học **contrastive learning** cần batch size lớn hơn."

        res = translate_text(
            "Contrastive learning needs a larger batch size.",
            config=TranslationConfig(provider="smart_ai"),
            groq_fetcher=fail_groq,
            gemini_fetcher=ok_gemini,
        )
        self.assertEqual(calls, ["groq", "gemini"])
        self.assertEqual(res.provider, "gemini")
        self.assertEqual(res.translated_text, "Học contrastive learning cần batch size lớn hơn.")
        self.assertNotIn("**", res.translated_text)

    def test_smart_ai_rejects_untranslated_english_echo_and_fails_over(self):
        src = "Contrastive learning benefits from larger batch sizes and more training epochs."
        res = translate_text(
            src,
            config=TranslationConfig(provider="smart_ai", target_lang="vi"),
            groq_fetcher=lambda text, cfg: text,  # Echoes English untranslated
            gemini_fetcher=lambda text, cfg: "Contrastive learning hưởng lợi từ batch size lớn hơn và nhiều epoch hơn.",
        )
        self.assertEqual(res.provider, "gemini")
        self.assertIn("hưởng lợi", res.translated_text)


if __name__ == "__main__":
    unittest.main()
