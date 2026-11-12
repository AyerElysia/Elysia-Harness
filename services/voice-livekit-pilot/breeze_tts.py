"""Breeze TTS 2 HTTP-to-LiveKit adapter. No inference or audio persistence."""

from __future__ import annotations

import asyncio
import hashlib
import math
import os
import stat
import tomllib
from collections.abc import AsyncGenerator
from contextlib import AsyncExitStack, aclosing
from dataclasses import dataclass, replace
from pathlib import Path
from uuid import uuid4
from weakref import WeakSet

import aiohttp
from livekit import rtc
from livekit.agents import APIError, tts
from livekit.agents.tts import tts as _livekit_tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions

SPEECH_URL = "http://127.0.0.1:7865/v1/audio/speech"
SAMPLE_RATE = 24_000
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1_000 * 2
MAX_PCM_BYTES = SAMPLE_RATE * 2 * 120
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_TIMEOUT_SECONDS = 180.0
READ_BYTES = 8 * 1024


class BreezeStreamError(APIError):
    """Fixed engineering error; no provider body, file paths, or text."""

    def __init__(self, code: str, status: int | None = None) -> None:
        self.code = code
        self.status = status
        suffix = "" if status is None else f"; HTTP {status}"
        super().__init__(f"Breeze stream failed ({code}{suffix}).", retryable=False)


def _positive(value: object, limit: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= limit


@dataclass(frozen=True, slots=True, repr=False)
class BreezeSettings:
    reference_path: Path
    reference_text: str
    instruction: str
    cfg_scale: float = 3.8
    seed: int = -1
    timeout_seconds: float = 180.0
    max_text_length: int = 1_000

    def __post_init__(self) -> None:
        if (
            not isinstance(self.reference_path, Path) or not self.reference_path.is_absolute()
            or not isinstance(self.reference_text, str) or not self.reference_text.strip()
            or not isinstance(self.instruction, str) or not self.instruction.strip()
            or not _positive(self.cfg_scale, 5)
            or type(self.seed) is not int or not -1 <= self.seed <= 0x7FFFFFFF
            or not _positive(self.timeout_seconds, math.inf)
            or not math.isfinite(self.timeout_seconds)
            or type(self.max_text_length) is not int or self.max_text_length < 1
        ):
            raise BreezeStreamError("invalid-settings")

    @classmethod
    def from_config(cls, path: str | Path | None = None) -> BreezeSettings:
        """Load only the deployment-owned default voice; ignore the shared server URL."""
        try:
            if path is None:
                root = Path(os.environ.get("ELYSIA_ROOT", "/home/ayerelysia/Elysia"))
                path = os.environ.get("ELYSIA_BREEZE_CONFIG") or (
                    root / "Elysium/config/plugins/tts_voice_plugin/config.toml"
                )
            config_path = Path(path)
            if not config_path.is_absolute():
                raise ValueError()
            with config_path.open("rb") as stream:
                config = tomllib.load(stream)
            service = config["tts"]
            if service["backend"].strip() != "breeze_tts2":
                raise ValueError()
            style, = (v for v in config["tts_styles"] if v.get("style_name", "").strip() == "default")
            return cls(
                reference_path=Path(style["refer_wav_path"].strip()),
                reference_text=style["prompt_text"].strip(),
                instruction=style["breeze_instruction"].strip(),
                cfg_scale=style.get("breeze_cfg_scale", 3.8),
                seed=style.get("breeze_seed", -1),
                timeout_seconds=service.get("timeout", 180),
                max_text_length=service.get("max_text_length", 1_000),
            )
        except (AttributeError, KeyError, OSError, TypeError, ValueError, OverflowError):
            raise BreezeStreamError("invalid-config") from None


def _read_reference(path: Path) -> bytes:
    # Nonblocking open plus a regular-file check prevent a mistaken FIFO/device
    # from stranding an asyncio worker on the local file read.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_REFERENCE_BYTES:
            raise BreezeStreamError("invalid-reference")
        reference = stream.read(MAX_REFERENCE_BYTES + 1)
        if not 0 < len(reference) <= MAX_REFERENCE_BYTES:
            raise BreezeStreamError("invalid-reference")
        return reference


def _seed(settings: BreezeSettings, text: str) -> int:
    if settings.seed >= 0:
        return settings.seed
    digest = hashlib.blake2s(("default\0" + text).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "little") & 0x7FFFFFFF


async def iter_pcm(
    settings: BreezeSettings,
    text: str,
    http_session: aiohttp.ClientSession,
    *,
    timeout_seconds: float | None = None,
) -> AsyncGenerator[bytes, None]:
    """Yield bounded 20 ms mono s16le frames and a possibly shorter final frame.

    Use `async with aclosing(iter_pcm(...))` when a consumer can stop between
    frames. Cancelling an in-progress read also closes the response immediately.
    """
    if not isinstance(text, str) or not text.strip() or len(text) > settings.max_text_length:
        raise BreezeStreamError("invalid-text-length")
    if timeout_seconds is not None and not _positive(timeout_seconds, MAX_TIMEOUT_SECONDS):
        raise BreezeStreamError("invalid-timeout")
    timeout = min(
        settings.timeout_seconds, MAX_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds,
    )
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    try:
        async with asyncio.timeout_at(deadline):
            try:
                reference = await asyncio.to_thread(_read_reference, settings.reference_path)
            except OSError:
                raise BreezeStreamError("reference-unavailable") from None
        form = aiohttp.FormData()
        form.add_field("text", text)
        form.add_field("instruction", settings.instruction)
        form.add_field("cfg_scale", str(settings.cfg_scale))
        form.add_field("ref_text", settings.reference_text)
        form.add_field("seed", str(_seed(settings, text)))
        form.add_field(
            "ref_audio", reference, content_type="audio/wav", filename=settings.reference_path.name,
        )
        async with AsyncExitStack() as stack:
            async with asyncio.timeout_at(deadline):
                response = await stack.enter_async_context(http_session.post(
                    SPEECH_URL, data=form, allow_redirects=False, raise_for_status=False,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                    headers={
                        "X-Breeze-Client": "voice-call",
                        "X-Breeze-Timeout-Ms": str(max(1, int(timeout * 1000))),
                        "Accept-Encoding": "identity",
                    },
                ))
            complete = False
            try:
                if response.status != 200:
                    raise BreezeStreamError("http", response.status)
                headers = response.headers
                if (
                    headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "audio/pcm"
                    or headers.get("X-Sample-Format", "").strip().lower() != "s16le"
                    or headers.get("X-Sample-Rate", "") != str(SAMPLE_RATE)
                    or headers.get("Content-Encoding", "identity").strip().lower() != "identity"
                ):
                    raise BreezeStreamError("invalid-pcm-format")
                pending = bytearray()
                received = 0
                chunks = response.content.iter_chunked(READ_BYTES).__aiter__()
                while True:
                    async with asyncio.timeout_at(deadline):
                        chunk = await anext(chunks, None)
                    if chunk is None:
                        break
                    received += len(chunk)
                    if len(chunk) > READ_BYTES or received > MAX_PCM_BYTES:
                        raise BreezeStreamError("pcm-limit")
                    pending.extend(chunk)
                    aligned = len(pending) - len(pending) % FRAME_BYTES
                    for offset in range(0, aligned, FRAME_BYTES):
                        if loop.time() >= deadline:
                            raise TimeoutError()
                        yield bytes(pending[offset:offset + FRAME_BYTES])
                    del pending[:aligned]
                if not received or len(pending) % 2:
                    raise BreezeStreamError("invalid-pcm-length")
                if pending:
                    if loop.time() >= deadline:
                        raise TimeoutError()
                    yield bytes(pending)
                if loop.time() >= deadline:
                    raise TimeoutError()
                complete = True
            finally:
                if not complete:
                    response.close()
    except TimeoutError:
        raise BreezeStreamError("timeout") from None
    except BreezeStreamError:
        raise
    except Exception:
        raise BreezeStreamError("transport") from None


class BreezeTTS(tts.TTS):
    """One local synthesis at a time; a caller-injected HTTP session stays caller-owned."""

    def __init__(
        self, settings: BreezeSettings, *, http_session: aiohttp.ClientSession | None = None,
    ) -> None:
        # LiveKit 1.8.11 can dump every emitted PCM segment to disk in debug
        # mode. Refuse to instantiate instead of mutating framework globals.
        if _livekit_tts.lk_dump_tts:
            raise BreezeStreamError("sdk-audio-dump-enabled")
        # The official interface streams output PCM but accepts complete text per
        # POST. LiveKit's StreamAdapter supplies sentence-wise input as needed.
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=SAMPLE_RATE, num_channels=1,
        )
        self._settings = settings
        self._http_session = http_session
        self._owns_session = http_session is None
        self._streams: WeakSet[_BreezeChunkedStream] = WeakSet()
        self._busy = False
        self._closing: asyncio.Task[None] | None = None

    @property
    def model(self) -> str:
        return "breeze-tts2-elysia-q8"

    @property
    def provider(self) -> str:
        return "local-breeze"

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> tts.ChunkedStream:
        if self._closing is not None:
            raise BreezeStreamError("closed")
        if not isinstance(text, str) or not text.strip() or len(text) > self._settings.max_text_length:
            raise BreezeStreamError("invalid-text-length")
        stream = _BreezeChunkedStream(self, text, replace(conn_options, max_retry=0))
        self._streams.add(stream)
        return stream

    async def _pcm(self, text: str) -> AsyncGenerator[bytes, None]:
        if self._closing is not None:
            raise BreezeStreamError("closed")
        if self._busy:
            raise BreezeStreamError("busy")
        self._busy = True
        try:
            if self._http_session is None:
                self._http_session = aiohttp.ClientSession(trust_env=False, auto_decompress=False)
            async with aclosing(iter_pcm(self._settings, text, self._http_session)) as stream:
                async for frame in stream:
                    yield frame
        finally:
            self._busy = False

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = asyncio.create_task(self._close())
        await asyncio.shield(self._closing)

    async def _close(self) -> None:
        try:
            results = await asyncio.gather(
                *(stream.aclose() for stream in list(self._streams)), return_exceptions=True,
            )
            if any(isinstance(result, BaseException) for result in results):
                raise BreezeStreamError("close-failed")
        finally:
            if self._owns_session and self._http_session is not None:
                try:
                    await self._http_session.close()
                except Exception:
                    raise BreezeStreamError("close-failed") from None


class _BreezeChunkedStream(tts.ChunkedStream):
    def __init__(self, owner: BreezeTTS, text: str, options: APIConnectOptions) -> None:
        self._owner = owner
        self._spoken_text = text
        # LiveKit 1.8.11 records input_text in a span. Keep content out of the
        # framework's TTS span while preserving the scalar character count.
        super().__init__(tts=owner, input_text="*" * len(text), conn_options=options)

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        try:
            output_emitter.initialize(
                request_id=uuid4().hex, sample_rate=SAMPLE_RATE, num_channels=1,
                mime_type="audio/pcm", frame_size_ms=FRAME_MS,
            )
            async with aclosing(self._owner._pcm(self._spoken_text)) as stream:
                async for frame in stream:
                    output_emitter.push_frame(rtc.AudioFrame(
                        data=frame, sample_rate=SAMPLE_RATE, num_channels=1,
                        samples_per_channel=len(frame) // 2,
                    ))
        finally:
            self._spoken_text = ""
