"""Logging helpers. Transcripts and raw audio are never logged by this package."""

from __future__ import annotations

import logging
import re
from typing import Any

_SECRET_PATTERNS = (
    re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s]+"),
    re.compile(r"(?i)((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+"),
    re.compile(r"\b(sk-|gsk_|AIza|hf_)[A-Za-z0-9_\-]{12,}\b"),
)


def configure(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("voxa.asr").setLevel(getattr(logging, str(level).upper(), logging.INFO))


def get_logger(name: str = "") -> logging.Logger:
    return logging.getLogger(f"voxa.asr.{name}" if name else "voxa.asr")


def redact(value: Any) -> str:
    text = str(value)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda match: match.group(1) + "[redacted]", text)
    return text


def safe_error(error: BaseException, limit: int = 800) -> str:
    return redact(error).replace("\r", " ").replace("\n", " ")[:limit]
