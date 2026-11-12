"""Bounded voice cascade clients; audio stays local when ASR is configured."""
from __future__ import annotations

import array
import base64
import io
import json
import math
import os
import re
import sys
import wave
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from urllib.parse import urlsplit

import aiohttp

INPUT_RATE = 16_000
FRAME_MS = 20
INPUT_FRAME_BYTES = INPUT_RATE * FRAME_MS // 1_000 * 2
MAX_VOICE_SECONDS = 20
MAX_VOICE_FRAMES = MAX_VOICE_SECONDS * 1_000 // FRAME_MS
MAX_INPUT_TEXT_BYTES = 2_048
MAX_OUTPUT_CHARS = 2_400
MAX_SSE_LINE = 64 * 1_024
MAX_SSE_BYTES = 4 * 1_024 * 1_024
MODEL_ID = re.compile(r"[A-Za-z0-9_.:/ -]{1,128}\Z")
LOOPBACK_ENDPOINT = "http://127.0.0.1:3000/v1/chat/completions"
GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
D1_ENDPOINT = "https://d1api.xin/v1/chat/completions"
ASR_ENDPOINT = "http://127.0.0.1:18796/transcribe"
MAX_ASR_RESPONSE_BYTES = 16_384
MAX_ASR_TEXT_UNITS = 2_000
PUNCTUATION = re.compile(r"[。！？!?；;\n]|(?<!\d)\.(?=\s|$)")


class GeminiError(Exception):
    """Only allow fixed failure codes and an HTTP status out of the provider boundary."""

    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True, repr=False)
class GeminiConfig:
    url: str
    model: str
    key: str
    proxy: str | None = None

    def __post_init__(self) -> None:
        if self.url not in {LOOPBACK_ENDPOINT, GOOGLE_ENDPOINT, D1_ENDPOINT}:
            raise GeminiError("gemini_endpoint_invalid")
        if not re.fullmatch(r"[!-~]{1,512}", self.key):
            raise GeminiError("gemini_credential_invalid")
        if not MODEL_ID.fullmatch(self.model) or self.model != self.model.strip():
            raise GeminiError("gemini_model_invalid")
        if self.proxy is not None:
            try:
                proxy = urlsplit(self.proxy)
                if (
                    self.url == LOOPBACK_ENDPOINT or proxy.scheme != "http"
                    or proxy.hostname != "127.0.0.1" or not proxy.port
                    or proxy.username is not None or proxy.password is not None
                    or proxy.path or proxy.query or proxy.fragment
                ):
                    raise ValueError()
            except ValueError:
                raise GeminiError("gemini_proxy_invalid") from None

    @classmethod
    def from_env(cls) -> GeminiConfig:
        return cls(
            os.environ.get("GEMINI_CASCADE_COMPLETIONS_URL", ""),
            os.environ.get("GEMINI_CASCADE_MODEL", ""),
            os.environ.get("GEMINI_CASCADE_API_KEY", ""),
            os.environ.get("GEMINI_CASCADE_HTTPS_PROXY") or None,
        )


@dataclass(frozen=True, slots=True, repr=False)
class AsrConfig:
    url: str
    key: str

    def __post_init__(self) -> None:
        if self.url != ASR_ENDPOINT or not re.fullmatch(r"[a-f0-9]{64}", self.key):
            raise GeminiError("asr_config_invalid")

    @classmethod
    def from_env(cls) -> AsrConfig | None:
        url = os.environ.get("GEMINI_CASCADE_ASR_URL")
        key = os.environ.get("GEMINI_CASCADE_ASR_KEY")
        if url is None and key is None:
            return None
        return cls(url or "", key or "")


def validate_voice_route(config: GeminiConfig, asr: AsrConfig | None) -> None:
    if config.url == D1_ENDPOINT and asr is None:
        raise GeminiError("asr_required_for_d1")


async def transcribe(config: AsrConfig, http: aiohttp.ClientSession, pcm: bytes) -> str:
    """Send one bounded turn only to the private local recognizer; never save it."""
    if not isinstance(pcm, bytes) or len(pcm) % 2 or len(pcm) > MAX_VOICE_FRAMES * INPUT_FRAME_BYTES:
        raise GeminiError("asr_failed")
    if len(pcm) < INPUT_RATE * 2 // 5:
        raise GeminiError("asr_no_speech")
    try:
        async with http.post(
            config.url, data=pcm, allow_redirects=False,
            headers={
                "Authorization": "Bearer " + config.key, "Content-Type": "application/octet-stream",
                "Accept": "application/json", "Accept-Encoding": "identity",
            },
            auto_decompress=False,
            timeout=aiohttp.ClientTimeout(total=10, connect=2, sock_read=10),
        ) as response:
            if response.status == 503:
                raise GeminiError("asr_busy")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if (
                response.status != 200 or content_type != "application/json"
                or response.headers.get("Content-Encoding", "identity").strip().lower() != "identity"
            ):
                raise GeminiError("asr_failed")
            body = bytearray()
            async for chunk in response.content.iter_chunked(2048):
                body.extend(chunk)
                if len(body) > MAX_ASR_RESPONSE_BYTES:
                    raise GeminiError("asr_failed")
            obj = json.loads(body.decode("utf-8"))
            if not isinstance(obj, dict) or set(obj) != {"text"} or not isinstance(obj["text"], str):
                raise GeminiError("asr_failed")
            result = obj["text"].strip()
            if (
                len(result.encode("utf-16-le")) > MAX_ASR_TEXT_UNITS * 2
                or any(ord(char) < 32 and char not in "\n\t" for char in result)
            ):
                raise GeminiError("asr_failed")
            return result
    except TimeoutError:
        raise GeminiError("asr_timeout") from None
    except GeminiError:
        raise
    except (aiohttp.ClientError, ValueError, TypeError, RecursionError):
        raise GeminiError("asr_failed") from None


def wav_input(pcm: bytes) -> dict:
    """Create an inline 16 kHz WAV in memory, never write/upload a file."""
    if not pcm or len(pcm) % 2 or len(pcm) > MAX_VOICE_FRAMES * INPUT_FRAME_BYTES:
        raise GeminiError("gemini_invalid_audio")
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(INPUT_RATE)
            wav.writeframes(pcm)
        return {"type": "input_audio", "input_audio": {
            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "format": "wav",
        }}


async def stream_reply(
    config: GeminiConfig,
    session: aiohttp.ClientSession,
    messages: list[dict],
    *,
    text_only: bool = False,
    read_timeout: float = 35,
) -> AsyncIterator[str]:
    if type(read_timeout) not in {int, float} or not 1 <= read_timeout <= 65:
        raise GeminiError("gemini_read_timeout_invalid")
    if (text_only or config.url == D1_ENDPOINT) and any(
        not isinstance(message, dict) or set(message) != {"role", "content"}
        or not isinstance(message["role"], str) or message["role"] not in {"system", "user", "assistant"}
        or not isinstance(message["content"], str)
        for message in messages
    ):
        # Independent protection against raw audio or audio-bearing parts.
        raise GeminiError("d1_text_required" if config.url == D1_ENDPOINT else "asr_text_required")
    payload = {"model": config.model, "messages": messages, "stream": True}
    try:
        async with session.post(
            config.url, json=payload, proxy=config.proxy, allow_redirects=False,
            headers={"Authorization": "Bearer " + config.key, "Accept": "text/event-stream"},
            timeout=aiohttp.ClientTimeout(total=75, connect=6, sock_read=read_timeout),
        ) as response:
            if response.status != 200:
                raise GeminiError("gemini_http", response.status)
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "text/event-stream":
                raise GeminiError("gemini_non_stream")
            seen = 0
            output = 0
            finished = False
            async for line in response.content:
                seen += len(line)
                if len(line) > MAX_SSE_LINE or seen > MAX_SSE_BYTES:
                    raise GeminiError("gemini_stream_limit")
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    finished = True
                    break
                obj = json.loads(data)
                if not isinstance(obj, dict) or obj.get("error"):
                    raise GeminiError("gemini_provider_error")
                choices = obj.get("choices")
                if not choices:
                    # Upstream may emit usage-only events.
                    continue
                if not isinstance(choices, list) or not isinstance(choices[0], dict):
                    raise GeminiError("gemini_invalid_stream")
                choice = choices[0]
                reason = choice.get("finish_reason")
                if reason not in {None, "stop", "length"}:
                    raise GeminiError("gemini_reply_unavailable")
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict):
                    raise GeminiError("gemini_invalid_stream")
                # Never consume thought/reasoning or provider-native audio fields.
                text = delta.get("content")
                if text is not None and not isinstance(text, str):
                    raise GeminiError("gemini_invalid_stream")
                if text:
                    budget = MAX_OUTPUT_CHARS - output
                    clean = "".join(c for c in text if c in "\n\t" or ord(c) >= 32)[:budget]
                    output += len(clean)
                    if clean:
                        yield clean
                    if output >= MAX_OUTPUT_CHARS:
                        return
                if reason:
                    finished = True
                    break
            if not finished or output == 0:
                raise GeminiError("gemini_incomplete_reply")
    except TimeoutError:
        raise GeminiError("gemini_timeout") from None
    except GeminiError:
        raise
    except (aiohttp.ClientError, ValueError, TypeError):
        raise GeminiError("gemini_invalid_stream") from None


class ClauseBuffer:
    """Cut readable phrases, not raw tokens; preserve punctuation and cap pending text."""

    def __init__(self, limit: int = 90) -> None:
        self.limit = max(1, min(limit, 120))
        self.pending = ""

    def push(self, text: str) -> list[str]:
        self.pending += text
        phrases = []
        while self.pending:
            boundary = PUNCTUATION.search(self.pending)
            if boundary is not None and boundary.end() <= self.limit:
                cut = boundary.end()
            elif len(self.pending) >= self.limit:
                cut = self.limit
                # Prefer an earlier natural pause without making one token per request.
                low = max(1, self.limit // 2)
                for index in range(self.limit - 1, low - 1, -1):
                    if self.pending[index] in "，、,：: ":
                        cut = index + 1
                        break
            else:
                break
            value, self.pending = self.pending[:cut].strip(), self.pending[cut:]
            if value:
                phrases.append(value)
        return phrases

    def finish(self) -> str:
        value, self.pending = self.pending.strip(), ""
        return value


class EnergyTurns:
    """Conservative local speech endpointing with lead-in, hangover, and a hard cap.

    The browser's WebRTC AEC remains required for speaker use. This is a light
    energy gate, not a claim of acoustic speaker separation or semantic VAD.
    """

    def __init__(self) -> None:
        self.leadin: deque[bytes] = deque(maxlen=12)
        self.frames: list[bytes] = []
        self.noise = 80.0
        self.run = 0
        self.silence = 0
        self.voiced = 0
        self.speaking = False
        self.wait_for_quiet = False

    def reset(self) -> None:
        self.leadin.clear()
        self.frames.clear()
        self.run = self.silence = self.voiced = 0
        self.speaking = False
        self.wait_for_quiet = False

    def feed(self, pcm: bytes, *, playback: bool = False) -> tuple[bool, bytes | None]:
        if len(pcm) != INPUT_FRAME_BYTES:
            return False, None
        samples = array.array("h", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
        threshold = max(460.0 if playback else 270.0, self.noise * (4.0 if playback else 2.7))
        loud = rms >= threshold
        if not loud and not self.speaking:
            self.noise = 0.99 * self.noise + 0.01 * min(rms, 350.0)

        if self.wait_for_quiet:
            self.silence = 0 if loud else self.silence + 1
            if self.silence >= 12:
                self.reset()
            return False, None

        if not self.speaking:
            self.leadin.append(pcm)
            self.run = self.run + 1 if loud else 0
            if self.run < (6 if playback else 3):
                return False, None
            self.speaking = True
            self.frames = list(self.leadin)
            self.voiced = self.run
            return True, None

        self.frames.append(pcm)
        self.voiced += int(loud)
        self.silence = 0 if loud else self.silence + 1
        cap = len(self.frames) >= MAX_VOICE_FRAMES
        if self.silence < 20 and not cap:
            return False, None
        body = None
        if self.voiced >= 8:
            # Keep 100 ms trailing silence; do not add the entire detection hangover.
            trim = max(0, self.silence - 5)
            body = b"".join(self.frames[: len(self.frames) - trim])
        self.reset()
        self.wait_for_quiet = cap
        return False, body
