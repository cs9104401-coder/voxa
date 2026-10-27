from __future__ import annotations

import unittest

from asr.schemas import Segment, Timings, Token, TranscriptionResult, Word


class SchemaTests(unittest.TestCase):
    def test_result_serializes_tokens_separately_from_words(self) -> None:
        result = TranscriptionResult(
            text="hello world",
            model_id="parakeet-tdt-0.6b-v3",
            backend="transformers-tdt",
            device="cpu",
            words=[Word(text="hello", start=0.0, end=0.25)],
            tokens=[Token(text="hel", start=0.0, end=0.08), Token(text="lo", start=0.08, end=0.24)],
            segments=[Segment(text="hello", start=0.0, end=0.25)],
            timings=Timings(audio_seconds=1.0, inference_seconds=0.5, total_seconds=0.5, real_time_factor=0.5),
        )
        payload = result.to_dict()
        self.assertEqual(payload["tokens"][0]["text"], "hel")
        self.assertNotIn("confidence", payload["tokens"][0])
        self.assertEqual(payload["words"][0]["text"], "hello")
        self.assertEqual(payload["timings"]["real_time_factor"], 0.5)

    def test_missing_metadata_stays_none(self) -> None:
        result = TranscriptionResult(text="x", model_id="m", backend="b", device="cpu")
        payload = result.to_dict()
        self.assertIsNone(payload["language"])
        self.assertIsNone(payload["words"])
        self.assertIsNone(payload["tokens"])
        self.assertEqual(payload["warnings"], [])


if __name__ == "__main__":
    unittest.main()
