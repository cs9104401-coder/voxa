from __future__ import annotations

import tempfile
import unittest

from asr.__main__ import build_parser, _config_from_args


class CliTests(unittest.TestCase):
    def test_common_flags_after_subcommand(self) -> None:
        args = build_parser().parse_args(
            ["transcribe", "--file", "clip.wav", "--model", "granite-speech-5.0-470m-turboctc", "--device", "cpu"]
        )
        self.assertEqual(args.command, "transcribe")
        self.assertEqual(args.model, "granite-speech-5.0-470m-turboctc")
        self.assertEqual(args.device, "cpu")

    def test_common_flags_before_subcommand(self) -> None:
        args = build_parser().parse_args(
            ["--model", "qwen3-asr-1.7b", "--json", "transcribe", "--file", "clip.wav"]
        )
        self.assertEqual(args.model, "qwen3-asr-1.7b")
        self.assertTrue(args.json)

    def test_explicit_subcommand_flag_wins(self) -> None:
        args = build_parser().parse_args(
            ["--model", "granite-speech-5.0-470m-turboctc", "transcribe", "--file", "x.wav", "--model", "whisper-tiny"]
        )
        self.assertEqual(args.model, "whisper-tiny")

    def test_config_merges_flags_and_environment(self) -> None:
        args = build_parser().parse_args(
            ["transcribe", "--file", "x.wav", "--device", "cpu", "--word-timestamps", "--no-vad"]
        )
        config = _config_from_args(args)
        self.assertEqual(config.device, "cpu")
        self.assertTrue(config.word_timestamps)
        self.assertFalse(config.vad)

    def test_mutually_exclusive_source(self) -> None:
        with self.assertRaises(SystemExit):
            build_parser().parse_args(["transcribe"])

    def test_models_command_has_no_file_requirement(self) -> None:
        args = build_parser().parse_args(["models"])
        self.assertEqual(args.command, "models")


if __name__ == "__main__":
    unittest.main()
