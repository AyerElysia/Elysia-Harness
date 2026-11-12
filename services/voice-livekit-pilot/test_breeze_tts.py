"""Offline tests: temporary fixtures and an injected fake HTTP session only."""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
import unittest
from contextlib import aclosing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from livekit.agents.types import APIConnectOptions

import breeze_tts as breeze

PCM_HEADERS = {
    "Content-Type": "audio/pcm",
    "X-Sample-Format": "s16le",
    "X-Sample-Rate": "24000",
}


class FakeResponse:
    def __init__(self, *chunks, status=200, headers=None, wait=False):
        self.status = status
        self.headers = PCM_HEADERS.copy() if headers is None else headers
        self.content = self
        self.chunks = chunks
        self.wait = wait
        self.read_pending = asyncio.Event()
        self.released = asyncio.Event()
        self.closed = False
        self.exited = False
        self.reads = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        self.exited = True

    async def iter_chunked(self, max_chunk_size):
        assert max_chunk_size == breeze.READ_BYTES
        self.reads += 1
        for chunk in self.chunks:
            yield chunk
        if self.wait:
            self.read_pending.set()
            await self.released.wait()

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.posts = []
        self.closed = False

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return self.response

    async def close(self):
        self.closed = True


class BreezeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.reference = self.root / "fixture.wav"
        self.reference.write_bytes(b"fake wav fixture")
        self.settings = breeze.BreezeSettings(
            reference_path=self.reference, reference_text="fake transcript",
            instruction="fake direction", cfg_scale=3.8, timeout_seconds=30,
            max_text_length=16,
        )

    def test_config_selects_only_fixed_default_voice(self):
        config = self.root / "config.toml"
        config.write_text(
            '[tts]\nbackend = "breeze_tts2"\nserver = "http://shared.invalid:7862"\n'
            'timeout = 30\nmax_text_length = 16\n'
            '[[tts_styles]]\nstyle_name = "unused"\nprompt_text = "ignore this"\n'
            '[[tts_styles]]\nstyle_name = "default"\n'
            f'refer_wav_path = "{self.reference.as_posix()}"\n'
            'prompt_text = "fake transcript"\nbreeze_instruction = "fake direction"\n',
            encoding="utf-8",
        )
        settings = breeze.BreezeSettings.from_config(config)
        self.assertEqual(settings, self.settings)
        self.assertNotIn("fake transcript", repr(settings))
        with self.assertRaisesRegex(breeze.BreezeStreamError, "invalid-config"):
            breeze.BreezeSettings.from_config("not/absolute.toml")

    async def test_first_pcm_frame_arrives_before_http_body_finishes(self):
        frame = b"\x01\x00" * 480
        reply = FakeResponse(frame[:1], frame[1:], wait=True)
        session = FakeSession(reply)
        async with aclosing(breeze.iter_pcm(self.settings, "[笑] 你好。", session)) as stream:
            self.assertEqual(await anext(stream), frame)
            self.assertFalse(reply.exited)
            tail = asyncio.create_task(anext(stream, None))
            await asyncio.wait_for(reply.read_pending.wait(), timeout=2)
            self.assertFalse(tail.done())
            reply.released.set()
            self.assertIsNone(await tail)
        self.assertTrue(reply.exited)
        self.assertFalse(reply.closed)
        url, options = session.posts[0]
        self.assertEqual(url, "http://127.0.0.1:7865/v1/audio/speech")
        self.assertFalse(options["allow_redirects"])
        self.assertFalse(options["raise_for_status"])
        self.assertEqual(options["headers"]["X-Breeze-Timeout-Ms"], "30000")
        fields = {field[0]["name"]: field[2] for field in options["data"]._fields}
        digest = hashlib.blake2s("default\0[笑] 你好。".encode()).digest()
        self.assertEqual(fields, {
            "text": "[笑] 你好。", "instruction": "fake direction", "ref_text": "fake transcript",
            "cfg_scale": "3.8", "seed": str(int.from_bytes(digest[:4], "little") & 0x7FFFFFFF),
            "ref_audio": b"fake wav fixture",
        })

    async def test_frame_and_sample_alignment_preserve_bytes(self):
        pcm = bytes(range(256)) * 7
        reply = FakeResponse(pcm[:1], pcm[1:977], pcm[977:])
        frames = [f async for f in breeze.iter_pcm(self.settings, "hello", FakeSession(reply))]
        self.assertEqual([len(f) for f in frames], [960, 832])
        self.assertEqual(b"".join(frames), pcm)

    async def test_configured_seed_and_transport_error_redaction(self):
        settings = replace(self.settings, seed=42)
        session = FakeSession(FakeResponse(b"\0\0"))
        self.assertEqual([f async for f in breeze.iter_pcm(settings, "hello", session)], [b"\0\0"])
        fields = {f[0]["name"]: f[2] for f in session.posts[0][1]["data"]._fields}
        self.assertEqual(fields["seed"], "42")
        with patch.object(session, "post", side_effect=RuntimeError("private provider detail")):
            with self.assertRaisesRegex(breeze.BreezeStreamError, "transport") as caught:
                await anext(breeze.iter_pcm(settings, "hello", session))
        self.assertNotIn("private provider detail", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    async def test_cancel_active_read_closes_http(self):
        reply = FakeResponse(wait=True)
        session = FakeSession(reply)
        stream = breeze.iter_pcm(self.settings, "hello", session)
        task = asyncio.create_task(anext(stream))
        await asyncio.wait_for(reply.read_pending.wait(), timeout=2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(reply.closed)
        self.assertTrue(reply.exited)
        self.assertEqual(len(session.posts), 1)

    async def test_stop_between_frames_closes_http(self):
        reply = FakeResponse(b"\0" * breeze.FRAME_BYTES, wait=True)
        async with aclosing(breeze.iter_pcm(self.settings, "hello", FakeSession(reply))) as stream:
            self.assertEqual(len(await anext(stream)), breeze.FRAME_BYTES)
        self.assertTrue(reply.closed)
        self.assertTrue(reply.exited)

    async def test_timeout_closes_response_without_replay(self):
        reply = FakeResponse(wait=True)
        session = FakeSession(reply)
        with self.assertRaisesRegex(breeze.BreezeStreamError, "timeout"):
            async for _ in breeze.iter_pcm(self.settings, "hello", session, timeout_seconds=0.2):
                self.fail("unexpected PCM")
        self.assertTrue(reply.closed)
        self.assertEqual(len(session.posts), 1)

    async def test_http_or_header_failure_never_reads_body(self):
        for status, headers, code in (
            (409, PCM_HEADERS, "http"), (302, PCM_HEADERS, "http"),
            (200, {**PCM_HEADERS, "X-Sample-Rate": "48000"}, "invalid-pcm-format"),
            (200, {**PCM_HEADERS, "X-Sample-Format": "f32le"}, "invalid-pcm-format"),
            (200, {**PCM_HEADERS, "Content-Type": "audio/wav"}, "invalid-pcm-format"),
        ):
            with self.subTest(status=status, code=code):
                reply = FakeResponse(status=status, headers=headers)
                session = FakeSession(reply)
                with self.assertRaises(breeze.BreezeStreamError) as caught:
                    await anext(breeze.iter_pcm(self.settings, "hello", session))
                self.assertEqual(caught.exception.code, code)
                self.assertFalse(caught.exception.retryable)
                self.assertTrue(reply.closed)
                self.assertEqual(reply.reads, 0)
                self.assertEqual(len(session.posts), 1)

    async def test_invalid_pcm_length_and_total_byte_bound(self):
        for chunks, code in (((), "invalid-pcm-length"), ((b"x",), "invalid-pcm-length"),
                             ((b"x" * 5,), "pcm-limit")):
            with self.subTest(code=code):
                reply = FakeResponse(*chunks)
                with patch.object(breeze, "MAX_PCM_BYTES", 4):
                    with self.assertRaisesRegex(breeze.BreezeStreamError, code):
                        await anext(breeze.iter_pcm(self.settings, "hello", FakeSession(reply)))
                self.assertTrue(reply.closed)

    async def test_livekit_chunked_stream_uses_real_emitter_and_redacted_base_text(self):
        pcm = bytes(range(240)) * 5
        reply = FakeResponse(pcm)
        session = FakeSession(reply)
        adapter = breeze.BreezeTTS(self.settings, http_session=session)
        self.addAsyncCleanup(adapter.aclose)
        self.assertFalse(adapter.capabilities.streaming)
        self.assertEqual(adapter.sample_rate, 24_000)
        self.assertEqual(adapter.num_channels, 1)
        async with adapter.synthesize("private phrase") as stream:
            self.assertEqual(stream.input_text, "*" * len("private phrase"))
            frames = [event.frame async for event in stream]
        # The SDK may split a 10ms tail to mark the final frame.
        self.assertEqual(sum(frame.samples_per_channel for frame in frames), 600)
        self.assertTrue(all(frame.sample_rate == 24_000 and frame.num_channels == 1 for frame in frames))
        self.assertEqual(b"".join(frame.data.tobytes() for frame in frames), pcm)
        self.assertEqual(len(session.posts), 1)
        self.assertFalse(session.closed)

    def test_livekit_debug_audio_dump_is_refused(self):
        with patch.object(breeze._livekit_tts, "lk_dump_tts", 1):
            with self.assertRaisesRegex(breeze.BreezeStreamError, "sdk-audio-dump-enabled"):
                breeze.BreezeTTS(self.settings)

    async def test_livekit_adapter_close_aborts_stream_but_does_not_close_borrowed_session(self):
        reply = FakeResponse(wait=True)
        session = FakeSession(reply)
        adapter = breeze.BreezeTTS(self.settings, http_session=session)
        self.addAsyncCleanup(adapter.aclose)
        adapter.synthesize("hello")
        await asyncio.wait_for(reply.read_pending.wait(), timeout=2)
        await adapter.aclose()
        self.assertTrue(reply.closed)
        self.assertFalse(session.closed)
        with self.assertRaisesRegex(breeze.BreezeStreamError, "closed"):
            adapter.synthesize("hello")

    async def test_livekit_adapter_refuses_concurrent_synthesis_instead_of_queueing(self):
        reply = FakeResponse(wait=True)
        session = FakeSession(reply)
        adapter = breeze.BreezeTTS(self.settings, http_session=session)
        self.addAsyncCleanup(adapter.aclose)
        async with adapter.synthesize("first"):
            await asyncio.wait_for(reply.read_pending.wait(), timeout=2)
            async with adapter.synthesize("second") as second:
                with self.assertRaisesRegex(breeze.BreezeStreamError, "busy"):
                    await anext(second)
        self.assertEqual(len(session.posts), 1)
        self.assertTrue(reply.closed)

    async def test_livekit_default_retries_are_never_used_for_breeze(self):
        reply = FakeResponse(status=503)
        session = FakeSession(reply)
        adapter = breeze.BreezeTTS(self.settings, http_session=session)
        self.addAsyncCleanup(adapter.aclose)
        async with adapter.synthesize("hello", conn_options=APIConnectOptions(max_retry=3)) as stream:
            with self.assertRaisesRegex(breeze.BreezeStreamError, "HTTP 503"):
                async for _ in stream:
                    self.fail("unexpected PCM")
        self.assertEqual(len(session.posts), 1)


if __name__ == "__main__":
    unittest.main()
