from __future__ import annotations

import unittest

from asr.backends.parakeet import _tokens_from_timestamps
from asr.backends.qwen3_asr import _language_name, _words_from_aligner
from asr.errors import UnsupportedLanguageError
from asr.schemas import Word


class ParakeetTimestampTests(unittest.TestCase):
    def test_batch_wrapper_and_seconds_are_preserved(self) -> None:
        timestamps = [[
            {"token": "Hel", "start": 0.0, "end": 0.24},
            {"token": "lo", "start": 0.24, "end": 0.48},
        ]]
        tokens = _tokens_from_timestamps(timestamps, duration=1.0)
        self.assertIsNotNone(tokens)
        self.assertEqual([token.text for token in tokens], ["Hel", "lo"])
        self.assertEqual(tokens[1].start, 0.24)

    def test_invalid_and_out_of_range_values_are_skipped(self) -> None:
        timestamps = [
            {"token": "ok", "start": 0.1, "end": 0.2},
            {"token": "bad", "start": "nope", "end": 0.2},
            {"token": "late", "start": 99.0, "end": 100.0},
            {"token": " ", "start": 0.1, "end": 0.2},
        ]
        tokens = _tokens_from_timestamps(timestamps, duration=1.0)
        self.assertEqual([token.text for token in tokens], ["ok"])

    def test_missing_timestamps_return_none(self) -> None:
        self.assertIsNone(_tokens_from_timestamps(None, duration=1.0))


class QwenHelpersTests(unittest.TestCase):
    def test_iso_codes_map_to_qwen_names(self) -> None:
        self.assertEqual(_language_name("en"), "English")
        self.assertEqual(_language_name("zh"), "Chinese")
        self.assertEqual(_language_name("English"), "English")

    def test_unsupported_language_is_structured(self) -> None:
        with self.assertRaises(UnsupportedLanguageError) as caught:
            _language_name("xx")
        self.assertEqual(caught.exception.code, "unsupported_language")
        self.assertIn("supported", caught.exception.details)

    def test_aligner_items_are_words_with_seconds(self) -> None:
        class Item:
            def __init__(self, text, start, end):
                self.text = text
                self.start_time = start
                self.end_time = end

        class Result:
            items = [Item("Hello", 0.0, 0.5), Item("world", 0.5, 1.0)]

        words = _words_from_aligner(Result(), duration=1.1)
        self.assertEqual([word.text for word in words], ["Hello", "world"])
        self.assertEqual(words[1].start, 0.5)
        self.assertIsInstance(words[0], Word)

    def test_aligner_out_of_range_items_are_skipped(self) -> None:
        class Result:
            items = [
                {"text": "ok", "start_time": 0.1, "end_time": 0.2},
                {"text": "late", "start_time": 50.0, "end_time": 51.0},
            ]

        words = _words_from_aligner(Result(), duration=1.0)
        self.assertEqual([word.text for word in words], ["ok"])


if __name__ == "__main__":
    unittest.main()
