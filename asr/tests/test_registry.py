from __future__ import annotations

import tempfile
import unittest

from asr.config import ASRConfig
from asr.errors import UnsupportedModelError
from asr.registry import (
    availability,
    create_backend,
    dependency_status,
    get_spec,
    list_specs,
)


class RegistryTests(unittest.TestCase):
    def test_aliases_resolve(self) -> None:
        self.assertEqual(get_spec("parakeet").id, "parakeet-tdt-0.6b-v3")
        self.assertEqual(get_spec("QWEN3").id, "qwen3-asr-1.7b")
        self.assertEqual(get_spec("granite").id, "granite-speech-5.0-470m-turboctc")
        self.assertEqual(get_spec("turbo").id, "whisper-large-v3-turbo")

    def test_unknown_model_is_structured(self) -> None:
        with self.assertRaises(UnsupportedModelError) as caught:
            get_spec("does-not-exist")
        self.assertEqual(caught.exception.code, "unsupported_model")

    def test_parakeet_reports_tokens_not_words(self) -> None:
        spec = get_spec("parakeet-tdt-0.6b-v3")
        self.assertTrue(spec.capabilities["token_timestamps"])
        self.assertFalse(spec.capabilities["word_timestamps"])
        self.assertFalse(spec.capabilities["native_streaming"])
        self.assertFalse(spec.capabilities["language_detection"])

    def test_qwen_is_long_form_and_detects_language(self) -> None:
        spec = get_spec("qwen3-asr-1.7b")
        self.assertTrue(spec.long_form)
        self.assertTrue(spec.capabilities["long_form"])
        self.assertTrue(spec.capabilities["language_detection"])
        self.assertFalse(spec.capabilities["native_streaming"])

    def test_granite_has_no_timestamps_or_language_label(self) -> None:
        spec = get_spec("granite-speech-5.0-470m-turboctc")
        self.assertFalse(spec.capabilities["word_timestamps"])
        self.assertFalse(spec.capabilities["token_timestamps"])
        self.assertFalse(spec.capabilities["language_detection"])

    def test_whisper_entries_match_existing_cache_names(self) -> None:
        spec = get_spec("whisper-large-v3-turbo")
        self.assertIn("large-v3-turbo", spec.cache_names)
        self.assertTrue(spec.capabilities["word_timestamps"])
        self.assertTrue(spec.capabilities["segment_timestamps"])

    def test_dependency_status_reports_missing_module(self) -> None:
        status = dependency_status((("module_that_does_not_exist_voxa", "package", None),))
        self.assertFalse(status["available"])
        self.assertEqual(status["missing"], ["package"])

    def test_backend_mismatch_is_rejected_before_import(self) -> None:
        config = ASRConfig(
            model="parakeet-tdt-0.6b-v3",
            backend="granite-transformers",
            cache_dir=tempfile.gettempdir(),
        )
        with self.assertRaises(UnsupportedModelError):
            create_backend(get_spec("parakeet-tdt-0.6b-v3"), config, None)

    def test_all_specs_are_serializable(self) -> None:
        for spec in list_specs():
            row = spec.public()
            self.assertEqual(row["id"], spec.id)
            self.assertIn("capabilities", row)
            self.assertIn("downloaded", {"downloaded"})  # public rows are augmented by the manager

    def test_availability_is_structured(self) -> None:
        row = availability(get_spec("whisper-tiny"))
        self.assertIn("available", row)
        self.assertIn("missing", row)
        self.assertIn("outdated", row)
        self.assertIn("reason", row)


if __name__ == "__main__":
    unittest.main()
