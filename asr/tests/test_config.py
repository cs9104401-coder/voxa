from __future__ import annotations

import os
import tempfile
import unittest

from asr.config import ASRConfig
from asr.errors import ASRError


class ConfigTests(unittest.TestCase):
    def test_defaults_match_voxa(self) -> None:
        config = ASRConfig(cache_dir=tempfile.gettempdir())
        self.assertEqual(config.model, "whisper-large-v3-turbo")
        self.assertEqual(config.device, "auto")
        self.assertEqual(config.backend, "auto")
        self.assertIsNone(config.language)
        self.assertTrue(config.vad)

    def test_environment_overrides(self) -> None:
        config = ASRConfig.from_env(
            env={
                "ASR_MODEL": "parakeet-tdt-0.6b-v3",
                "ASR_BACKEND": "transformers-tdt",
                "ASR_DEVICE": "cpu",
                "ASR_COMPUTE_TYPE": "float32",
                "ASR_MODEL_CACHE": tempfile.gettempdir(),
                "ASR_LANGUAGE": "en",
                "ASR_WORD_TIMESTAMPS": "yes",
                "ASR_VAD": "off",
                "ASR_CHUNK_SECONDS": "12.5",
                "ASR_LOG_LEVEL": "debug",
                "ASR_OFFLINE": "true",
            }
        )
        self.assertEqual(config.model, "parakeet-tdt-0.6b-v3")
        self.assertEqual(config.backend, "transformers-tdt")
        self.assertEqual(config.device, "cpu")
        self.assertEqual(config.compute_type, "float32")
        self.assertEqual(config.language, "en")
        self.assertTrue(config.word_timestamps)
        self.assertFalse(config.vad)
        self.assertEqual(config.chunk_seconds, 12.5)
        self.assertEqual(config.log_level, "DEBUG")
        self.assertTrue(config.offline)

    def test_explicit_overrides_win_over_environment(self) -> None:
        config = ASRConfig.from_env(
            overrides={"model": "granite-speech-5.0-470m-turboctc", "device": "cpu"},
            env={"ASR_MODEL": "qwen3-asr-1.7b", "ASR_DEVICE": "cuda", "ASR_MODEL_CACHE": tempfile.gettempdir()},
        )
        self.assertEqual(config.model, "granite-speech-5.0-470m-turboctc")
        self.assertEqual(config.device, "cpu")

    def test_invalid_environment_is_rejected(self) -> None:
        for env in (
            {"ASR_DEVICE": "tpu"},
            {"ASR_BACKEND": "made-up"},
            {"ASR_VAD": "sometimes"},
            {"ASR_CHUNK_SECONDS": "0"},
            {"ASR_CHUNK_SECONDS": "999"},
            {"ASR_LOG_LEVEL": "LOUD"},
        ):
            with self.subTest(env=env), self.assertRaises(ASRError):
                ASRConfig.from_env(env={**env, "ASR_MODEL_CACHE": tempfile.gettempdir()})

    def test_service_token_cannot_contain_newlines(self) -> None:
        with self.assertRaises(ASRError):
            ASRConfig(service_token="one\ntwo", cache_dir=tempfile.gettempdir())

    def test_public_dict_omits_token(self) -> None:
        config = ASRConfig(service_token="secret-token", cache_dir=tempfile.gettempdir())
        public = config.as_public_dict()
        self.assertNotIn("service_token", public)
        self.assertNotIn("secret-token", repr(public))

    def test_environment_does_not_leak_the_service_token_on_disk_paths(self) -> None:
        previous = os.environ.pop("ASR_MODEL_CACHE", None)
        try:
            config = ASRConfig.from_env(env={})
            self.assertTrue(config.cache_dir)
        finally:
            if previous is not None:
                os.environ["ASR_MODEL_CACHE"] = previous


if __name__ == "__main__":
    unittest.main()
