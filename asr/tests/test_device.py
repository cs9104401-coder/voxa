from __future__ import annotations

import tempfile
import unittest
from unittest import mock

from asr.device import compute_type_for, resolve_device, torch_dtype_for
from asr.errors import DeviceUnavailableError


class DeviceTests(unittest.TestCase):
    def test_compute_types(self) -> None:
        self.assertEqual(compute_type_for("cpu"), "int8")
        self.assertEqual(compute_type_for("cuda"), "float16")
        self.assertEqual(compute_type_for("cuda", "int8_float16"), "int8_float16")
        with self.assertRaises(DeviceUnavailableError):
            compute_type_for("cpu", "float16")
        self.assertEqual(torch_dtype_for("cuda"), "float16")
        self.assertEqual(torch_dtype_for("cpu"), "float32")
        self.assertEqual(torch_dtype_for("cuda", "bfloat16"), "bfloat16")

    def test_explicit_cuda_unavailable_is_an_error(self) -> None:
        with mock.patch("asr.device.cuda_status", return_value={"available": False, "count": 0, "reason": "no gpu"}):
            with self.assertRaises(DeviceUnavailableError):
                resolve_device("cuda", framework="torch")

    def test_auto_falls_back_with_a_warning(self) -> None:
        with mock.patch("asr.device.cuda_status", return_value={"available": False, "count": 0, "reason": "no gpu"}):
            device, warnings = resolve_device("auto", framework="torch")
        self.assertEqual(device, "cpu")
        self.assertTrue(warnings)
        self.assertIn("no gpu", warnings[0])

    def test_auto_uses_cuda_when_available(self) -> None:
        with mock.patch("asr.device.cuda_status", return_value={"available": True, "count": 1, "reason": ""}):
            device, warnings = resolve_device("auto", framework="torch")
        self.assertEqual(device, "cuda")
        self.assertEqual(warnings, [])

    def test_cpu_never_checks_cuda(self) -> None:
        with mock.patch("asr.device.cuda_status", side_effect=AssertionError("should not run")):
            self.assertEqual(resolve_device("cpu", framework="torch"), ("cpu", []))


if __name__ == "__main__":
    unittest.main()
