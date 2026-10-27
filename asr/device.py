"""Device and compute-type selection with explicit, honest fallback reporting."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from .errors import DeviceUnavailableError

LOGGER = logging.getLogger("voxa.asr.device")

CPU_COMPUTE_TYPES = ("int8", "int8_float32", "float32", "auto")
CUDA_COMPUTE_TYPES = ("float16", "int8_float16", "bfloat16", "float32", "auto")
TORCH_COMPUTE_TYPES = ("float16", "bfloat16", "float32", "auto")


@lru_cache(maxsize=2)
def cuda_status(framework: str = "torch") -> dict[str, Any]:
    """Detect CUDA for a particular framework.

    ``torch.cuda.is_available()`` can be true while the installed wheel has no
    kernels for the GPU architecture (for example an sm_120 RTX 50-series card
    with a cu124 wheel). Checking the architecture list avoids claiming a GPU
    path that will fail on the first matrix multiplication.
    """
    if framework == "ctranslate2":
        try:
            import ctranslate2  # type: ignore

            count = int(ctranslate2.get_cuda_device_count())
            if count > 0:
                return {"available": True, "count": count, "source": "ctranslate2", "reason": ""}
            return {
                "available": False,
                "count": 0,
                "source": "ctranslate2",
                "reason": "CTranslate2 did not detect a CUDA device.",
            }
        except Exception as exc:  # pragma: no cover - host runtime dependent
            return {
                "available": False,
                "count": 0,
                "source": "ctranslate2",
                "reason": f"CTranslate2 CUDA check failed: {exc}",
            }

    try:
        import torch  # type: ignore
    except Exception as exc:
        return {
            "available": False,
            "count": 0,
            "source": "torch",
            "reason": f"PyTorch is not installed ({exc}).",
        }
    try:
        if not torch.cuda.is_available():
            return {
                "available": False,
                "count": 0,
                "source": "torch",
                "reason": "torch.cuda.is_available() is false.",
                "torch_version": str(getattr(torch, "__version__", "")),
            }
        count = int(torch.cuda.device_count())
        name = str(torch.cuda.get_device_name(0)) if count else ""
        capability = tuple(int(part) for part in torch.cuda.get_device_capability(0)) if count else ()
        arch_list = [str(item) for item in getattr(torch.cuda, "get_arch_list", lambda: [])()]
        wanted = f"sm_{capability[0]}{capability[1]}" if len(capability) == 2 else ""
        if wanted and arch_list and wanted not in arch_list:
            return {
                "available": False,
                "count": count,
                "source": "torch",
                "name": name,
                "capability": wanted,
                "arch_list": arch_list,
                "torch_version": str(getattr(torch, "__version__", "")),
                "reason": (
                    f"The installed PyTorch build has no kernels for {name} ({wanted}); "
                    f"it supports {', '.join(arch_list)}. Install a newer CUDA wheel or use CPU."
                ),
            }
        return {
            "available": True,
            "count": count,
            "source": "torch",
            "name": name,
            "capability": wanted,
            "arch_list": arch_list,
            "torch_version": str(getattr(torch, "__version__", "")),
            "reason": "",
        }
    except Exception as exc:  # pragma: no cover - host runtime dependent
        return {
            "available": False,
            "count": 0,
            "source": "torch",
            "reason": f"PyTorch CUDA check failed: {exc}",
        }


def clear_device_cache() -> None:
    cuda_status.cache_clear()


def resolve_device(requested: str, framework: str = "torch") -> tuple[str, list[str]]:
    """Return the effective device and warnings. Explicit CUDA never silently becomes CPU."""
    request = str(requested or "auto").lower()
    if request == "cpu":
        return "cpu", []
    status = cuda_status(framework)
    if request == "cuda":
        if not status.get("available"):
            raise DeviceUnavailableError(
                f"CUDA was requested for the {framework} backend but is not available. "
                + str(status.get("reason") or "No CUDA device was found.")
            )
        return "cuda", []
    if request != "auto":
        raise DeviceUnavailableError(f"Unsupported device '{request}'.")
    if status.get("available"):
        return "cuda", []
    return "cpu", [f"CUDA is unavailable for the {framework} backend; using CPU. {status.get('reason', '')}".strip()]


def compute_type_for(device: str, requested: str = "") -> str:
    """CTranslate2 compute type (faster-whisper)."""
    text = str(requested or "").strip().lower()
    if text and text != "auto":
        allowed = CUDA_COMPUTE_TYPES if device == "cuda" else CPU_COMPUTE_TYPES
        if text not in allowed:
            raise DeviceUnavailableError(
                f"Compute type '{text}' is not supported by CTranslate2 on {device}. "
                f"Choose one of {', '.join(allowed)}."
            )
        return text
    return "float16" if device == "cuda" else "int8"


def torch_dtype_for(device: str, requested: str = "") -> str:
    """Torch dtype name (Transformers backends)."""
    text = str(requested or "").strip().lower()
    if text and text != "auto":
        allowed = TORCH_COMPUTE_TYPES if device == "cuda" else ("float32", "bfloat16", "auto")
        if text not in allowed:
            raise DeviceUnavailableError(
                f"Compute type '{text}' is not supported by the Transformers backend on {device}. "
                f"Choose one of {', '.join(allowed)}."
            )
        return "float32" if text == "auto" else text
    return "float16" if device == "cuda" else "float32"


def describe(device: str) -> dict[str, Any]:
    torch_status = cuda_status("torch")
    ctranslate_status = cuda_status("ctranslate2")
    return {
        "device": device,
        "cuda_available": bool(torch_status.get("available")),
        "cuda_device_count": int(torch_status.get("count") or 0),
        "cuda_name": torch_status.get("name"),
        "reason": torch_status.get("reason") or "",
        "torch": dict(torch_status),
        "ctranslate2": dict(ctranslate_status),
    }
