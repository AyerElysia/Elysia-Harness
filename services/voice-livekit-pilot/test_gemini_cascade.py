"""Offline cascade tests: no credentials, provider, microphone, or synthesis calls."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import struct
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

from gemini_cascade import (
    ASR_ENDPOINT, D1_ENDPOINT, AsrConfig, ClauseBuffer, EnergyTurns, GeminiConfig, GeminiError,
    INPUT_FRAME_BYTES, INPUT_RATE, LOOPBACK_ENDPOINT, stream_reply, transcribe, validate_voice_route, wav_input,
)
from gemini_worker import Conversation, Events, dispatch_identity, dispatch_target, parse_input

SILENCE = b"\0" * INPUT_FRAME_BYTES
LOUD = struct.pack("<h", 2_800) * (INPUT_FRAME_BYTES // 2)
ROOM = "elysia-voice-pilot-" + "1" * 32
CASCADE_ROOM = "elysia-gemini-cascade-" + "1" * 32


class Content:
    def __init__(self, lines):
        self.lines = lines

    async def __aiter__(self):
        for line in self.lines:
            yield line

    async def iter_chunked(self, _n):
        for line in self.lines:
            yield line


class HTTP:
    def __init__(self, lines=(), status=200, mime="text/event-stream"):
        self.lines, self.status, self.mime = lines, status, mime
        self.closed = False
        self.last = None

    def post(self, url, **kwargs):
        self.last = (url, kwargs)
        return self

    async def __aenter__(self):
        return SimpleNamespace(
            status=self.status, headers={"Content-Type": self.mime}, content=Content(self.lines),
        )

    async def __aexit__(self, *_exc):
        self.closed = True


def sse(**obj):
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n").encode()


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_dispatch_and_typed_bounds(self):
        self.assertEqual(dispatch_identity(ROOM, '{"participantIdentity":"pilot-user-a"}'), "pilot-user-a")
        self.assertIsNone(dispatch_identity(ROOM, '{"participantIdentity":"x","role":"agent"}'))
        self.assertIsNone(dispatch_identity("unrelated", '{"participantIdentity":"x"}'))
        self.assertEqual(parse_input('{"type":"text","text":"你好"}'.encode()), "你好")
        self.assertIsNone(parse_input(b'{"type":"text","text":"\\ud800"}'))
        self.assertIsNone(parse_input(b'{"type":"text","text":"x","session":"other"}'))
        self.assertIsNone(parse_input(json.dumps({"type": "text", "text": "测" * 700}, ensure_ascii=False).encode()))

    def test_main_dispatch_is_explicit_and_cascade_only(self):
        metadata = '{"participantIdentity":"pilot-user-a","turnMode":"main-session"}'
        self.assertEqual(dispatch_target(CASCADE_ROOM, metadata), ("pilot-user-a", "main-session"))
        self.assertIsNone(dispatch_target(ROOM, metadata))
        self.assertIsNone(dispatch_target(CASCADE_ROOM, metadata.replace("main-session", "other-session")))
        self.assertIsNone(dispatch_target(CASCADE_ROOM, '{"participantIdentity":"pilot-user-a","turnMode":true}'))

    def test_direct_audio_is_wav_without_stt_or_file(self):
        part = wav_input(LOUD)
        self.assertEqual(part["type"], "input_audio")
        payload = base64.b64decode(part["input_audio"]["data"], validate=True)
        with wave.open(io.BytesIO(payload), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getsampwidth()), (1, INPUT_RATE, 2))
            self.assertEqual(wav.readframes(10_000), LOUD)

    def test_origin_and_redirect_restrictions(self):
        for url in (
            "http://127.0.0.1:3000/other", "http://127.0.0.2:3000/v1/chat/completions",
            "https://example.com/v1/chat/completions",
        ):
            with self.assertRaisesRegex(GeminiError, "gemini_endpoint_invalid"):
                GeminiConfig(url, "fixture-model", "fixture")
        with self.assertRaisesRegex(GeminiError, "gemini_proxy_invalid"):
            GeminiConfig(LOOPBACK_ENDPOINT, "fixture-model", "fixture", "http://127.0.0.1:1")

    def test_vad_has_lead_in_hangover_and_more_conservative_barge_in(self):
        v = EnergyTurns()
        for _ in range(5):
            self.assertEqual(v.feed(SILENCE), (False, None))
        for _ in range(5):
            self.assertEqual(v.feed(LOUD, playback=True), (False, None))
        self.assertEqual(v.feed(LOUD, playback=True), (True, None))
        for _ in range(8):
            v.feed(LOUD)
        for _ in range(19):
            self.assertIsNone(v.feed(SILENCE)[1])
        _, body = v.feed(SILENCE)
        self.assertIsInstance(body, bytes)
        self.assertTrue(body.startswith(SILENCE * 5))
        self.assertTrue(body.endswith(SILENCE * 5))
        self.assertFalse(body.endswith(SILENCE * 6))
        self.assertFalse(v.speaking)

    def test_clause_buffer_does_not_wait_for_complete_reply(self):
        b = ClauseBuffer()
        self.assertEqual(b.push("你好"), [])
        self.assertEqual(b.push("！下一句话"), ["你好！"])
        self.assertEqual(b.finish(), "下一句话")

    async def test_sse_audio_request_uses_visible_text_only(self):
        conf = GeminiConfig(LOOPBACK_ENDPOINT, "fixture-model", "fixture")
        http = HTTP([
            sse(choices=[{"delta": {"reasoning_content": "hidden", "content": "你好"}}]),
            b"\n",
            sse(choices=[{"delta": {"content": "呀"}, "finish_reason": "stop"}]),
            b"data: [DONE]\n",
        ])
        messages = [{"role": "user", "content": [wav_input(LOUD)]}]
        self.assertEqual([p async for p in stream_reply(conf, http, messages)], ["你好", "呀"])
        self.assertTrue(http.closed)
        self.assertFalse(http.last[1]["allow_redirects"])
        self.assertTrue(http.last[1]["json"]["stream"])
        self.assertEqual(http.last[1]["json"]["messages"], messages)

    async def test_provider_failure_is_sanitized_and_premature_close_is_not_success(self):
        conf = GeminiConfig(LOOPBACK_ENDPOINT, "fixture-model", "fixture")
        for http, code in (
            (HTTP(status=403), "gemini_http"),
            (HTTP(mime="application/json"), "gemini_non_stream"),
            (HTTP([sse(error={"message": "secret"})]), "gemini_provider_error"),
            (HTTP([sse(choices=[{"delta": {"content": "不完整"}}])]), "gemini_incomplete_reply"),
        ):
            with self.assertRaisesRegex(GeminiError, "^" + code + "$"):
                async for _ in stream_reply(conf, http, []):
                    pass
            self.assertTrue(http.closed)


    def test_asr_opt_in_fails_closed_and_d1_requires_asr(self):
        d1 = GeminiConfig(D1_ENDPOINT, "fixture-model", "fixture")
        with patch.dict("gemini_cascade.os.environ", {}, clear=True):
            self.assertIsNone(AsrConfig.from_env())
            with self.assertRaisesRegex(GeminiError, "asr_required_for_d1"):
                validate_voice_route(d1, None)
        with patch.dict("gemini_cascade.os.environ", {"GEMINI_CASCADE_ASR_URL": ASR_ENDPOINT}, clear=True):
            with self.assertRaisesRegex(GeminiError, "asr_config_invalid"):
                AsrConfig.from_env()
        with self.assertRaisesRegex(GeminiError, "asr_config_invalid"):
            AsrConfig("http://localhost:18796/transcribe", "a" * 64)
        validate_voice_route(d1, AsrConfig(ASR_ENDPOINT, "a" * 64))

    async def test_asr_request_is_raw_local_pcm_and_has_bounded_timeout(self):
        conf = AsrConfig(ASR_ENDPOINT, "a" * 64)
        fixture = b'{"text":" hello "}'
        http = HTTP([fixture[:7], fixture[7:]], mime="application/json; charset=utf-8")
        pcm = LOUD * 12
        self.assertEqual(await transcribe(conf, http, pcm), "hello")
        url, request = http.last
        self.assertEqual(url, ASR_ENDPOINT)
        self.assertEqual(request["data"], pcm)
        self.assertEqual(request["headers"]["Content-Type"], "application/octet-stream")
        self.assertEqual(request["headers"]["Authorization"], "Bearer " + "a" * 64)
        self.assertFalse(request["allow_redirects"])
        self.assertEqual(request["timeout"].total, 10)
        self.assertTrue(http.closed)
        with self.assertRaisesRegex(GeminiError, "asr_no_speech"):
            await transcribe(conf, http, LOUD * 4)

    async def test_asr_rejects_busy_invalid_and_oversized_response(self):
        conf = AsrConfig(ASR_ENDPOINT, "a" * 64)
        for http, code in (
            (HTTP(status=503), "asr_busy"),
            (HTTP(status=400), "asr_failed"),
            (HTTP([b'{"text":1}'], mime="application/json"), "asr_failed"),
            (HTTP([b"x" * 17_000], mime="application/json"), "asr_failed"),
            (HTTP([b'{"text":"\\ud800"}'], mime="application/json"), "asr_failed"),
            (HTTP([json.dumps({"text": "😀" * 1_001}, ensure_ascii=False).encode()], mime="application/json"), "asr_failed"),
        ):
            with self.assertRaisesRegex(GeminiError, "^" + code + "$"):
                await transcribe(conf, http, LOUD * 12)
            self.assertTrue(http.closed)
        self.assertEqual(
            await transcribe(conf, HTTP([b'{"text":""}'], mime="application/json"), LOUD * 12), "",
        )

    async def test_asr_cancel_unwinds_local_http_context(self):
        ready = asyncio.Event()

        class BlockingHTTP(HTTP):
            async def __aenter__(self):
                class Body:
                    async def iter_chunked(self, _n):
                        ready.set()
                        await asyncio.Future()
                        yield b""
                return SimpleNamespace(status=200, headers={"Content-Type": "application/json"}, content=Body())

        http = BlockingHTTP()
        task = asyncio.create_task(transcribe(AsrConfig(ASR_ENDPOINT, "a" * 64), http, LOUD * 12))
        await asyncio.wait_for(ready.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(http.closed)

    async def test_asr_llm_boundary_blocks_any_audio_parts_even_on_a6(self):
        for endpoint, text_only, code in (
            (D1_ENDPOINT, False, "d1_text_required"), (LOOPBACK_ENDPOINT, True, "asr_text_required"),
        ):
            http = HTTP()
            with self.assertRaisesRegex(GeminiError, code):
                _ = [value async for value in stream_reply(
                    GeminiConfig(endpoint, "fixture-model", "fixture"),
                    http, [{"role": "user", "content": [wav_input(LOUD)]}], text_only=text_only,
                )]
            self.assertIsNone(http.last)
        http = HTTP([sse(choices=[{"delta": {"content": "你好"}, "finish_reason": "stop"}])])
        result = [value async for value in stream_reply(
            GeminiConfig(LOOPBACK_ENDPOINT, "fixture-model", "fixture"),
            http, [{"role": "user", "content": "文本"}], text_only=True, read_timeout=65,
        )]
        self.assertEqual(result, ["你好"])
        self.assertEqual(http.last[1]["timeout"].sock_read, 65)

class Audio:
    def __init__(self):
        self.got = asyncio.Event()
        self.drain = asyncio.Event()
        self.clears = 0
        self.count = 0

    def clear_queue(self):
        self.clears += 1

    async def capture_frame(self, frame):
        self.count += 1
        self.got.set()

    async def wait_for_playout(self):
        await self.drain.wait()


class CallEvents:
    def __init__(self):
        self.events = []
        self.ended = asyncio.Event()
        self.finished = asyncio.Event()

    def send(self, kind, turn, **fields):
        self.events.append((kind, turn, fields))
        if kind == "done":
            self.finished.set()


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_main_asr_posts_only_verified_text_and_polls_bounded_native_output(self):
        seen = []
        poll_responses = iter([
            {"seq": 0, "text": "", "done": False},
            {"seq": 5, "text": "收到。😀", "done": False},
            {"seq": 7, "text": "然后", "done": True},
        ])

        class NativeHTTP(HTTP):
            def post(self, url, **kwargs):
                obj = kwargs["json"]
                seen.append(obj)
                assert url == "http://127.0.0.1:18793/events"
                assert kwargs["headers"]["Authorization"] == "Bearer fixture"
                assert kwargs["allow_redirects"] is False
                self.lines = (
                    [json.dumps(next(poll_responses), ensure_ascii=False).encode()] if obj["type"] == "poll" else []
                )
                return super().post(url, **kwargs)

        sink = Events(None, CASCADE_ROOM, "pilot-user-a", NativeHTTP(mime="application/json"),
                      ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event(), turn_mode="main-session")
        with patch("gemini_worker.NATIVE_POLL_INTERVAL", 0):
            self.assertEqual([value async for value in sink.native_reply(1, "已转写")], ["收到。😀", "然后"])
        self.assertEqual(seen, [
            {"roomName": CASCADE_ROOM, "type": "user", "turn": 1, "input": "voice", "text": "已转写"},
            *({"roomName": CASCADE_ROOM, "type": "poll", "turn": 1, "seq": seq} for seq in (0, 0, 5)),
        ])
        sink.send("user", 1, input="voice", text="已转写")
        sink.send("delta", 1, text="收到。")
        sink.send("done", 1, text="收到。然后")
        sink.send("error", 2, code="breeze_failed")
        self.assertEqual(sink.journal.qsize(), 1)
        self.assertEqual(sink.journal.get_nowait(), {"roomName": CASCADE_ROOM, "type": "interrupted", "turn": 2})

    async def test_main_poll_rejects_inconsistent_or_oversized_text_without_retrying_input(self):
        for response in (
            {"seq": 1, "text": "", "done": False},
            {"seq": 2_401, "text": "x" * 2_401, "done": True},
            {"seq": 0, "text": "", "done": False, "reasoning": "not allowed"},
            {"seq": 0, "text": "", "done": False, "error": "private-provider-detail"},
        ):
            seen = []

            class BadNativeHTTP(HTTP):
                def post(self, url, **kwargs):
                    seen.append(kwargs["json"]["type"])
                    self.lines = [json.dumps(response).encode()]
                    return super().post(url, **kwargs)

            sink = Events(None, CASCADE_ROOM, "pilot-user-a", BadNativeHTTP(mime="application/json"),
                          ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event(), turn_mode="main-session")
            with self.assertRaisesRegex(GeminiError, "^voice_main_turn_failed$"):
                _ = [value async for value in sink.native_reply(1, "已转写")]
            self.assertEqual(seen, ["user", "poll"])

    async def test_main_barge_in_cancels_only_voice_mirror_and_never_creates_model_history(self):
        audio, events = Audio(), CallEvents()
        poll_closed = asyncio.Event()
        native = []
        synthesized = []

        async def recognize(_asr, _http, body):
            self.assertIsInstance(body, bytes)
            return "已转写"

        async def native_reply(turn, transcript):
            native.append((turn, transcript))
            if turn == 1:
                try:
                    yield "正在朗读。"
                    await asyncio.Future()
                finally:
                    poll_closed.set()
            else:
                yield "接下来的回复。"

        async def tts(_settings, phrase, _http, **_kw):
            synthesized.append(phrase)
            yield b"\0" * 960

        events.native_reply = native_reply
        call = Conversation(audio, events, None, None, SimpleNamespace(max_text_length=90), object(), "",
                            asr=AsrConfig(ASR_ENDPOINT, "a" * 64), turn_mode="main-session")
        with patch("gemini_worker.transcribe", recognize), patch("gemini_worker.iter_pcm", tts), patch(
            "gemini_worker.stream_reply", side_effect=AssertionError("Main mode must not call another LLM"),
        ) as provider:
            call.handle_text("RTC data must not bypass the regular DSH composer")
            self.assertEqual(call.turn, 0)
            call._submit("voice", LOUD * 12)
            await asyncio.wait_for(audio.got.wait(), 1)
            for _ in range(15):
                call.handle_audio(LOUD)
            await asyncio.wait_for(poll_closed.wait(), 1)
            self.assertIn(("interrupted", 1, {}), events.events)
            for _ in range(20):
                call.handle_audio(SILENCE)
            audio.drain.set()
            await asyncio.wait_for(events.finished.wait(), 1)
            provider.assert_not_called()
        self.assertEqual(len(call.history), 0)
        self.assertEqual(native, [(1, "已转写"), (2, "已转写")])
        self.assertEqual(synthesized, ["正在朗读。", "接下来的回复。"])
        self.assertEqual([turn for kind, turn, _ in events.events if kind == "done"], [2])
        await call.aclose()

    async def test_main_silent_native_turn_is_not_a_failure(self):
        audio, events = Audio(), CallEvents()
        audio.drain.set()

        async def recognize(*_args):
            return "留在主会话里的输入"

        async def silent(*_args):
            if False:
                yield ""

        events.native_reply = silent
        call = Conversation(audio, events, None, None, SimpleNamespace(max_text_length=90), object(), "",
                            asr=AsrConfig(ASR_ENDPOINT, "a" * 64), turn_mode="main-session")
        with patch("gemini_worker.transcribe", recognize), patch(
            "gemini_worker.iter_pcm", side_effect=AssertionError("Silent turn must not reach Breeze"),
        ) as breeze:
            call._submit("voice", LOUD * 12)
            await asyncio.wait_for(call.active, 1)
            breeze.assert_not_called()
        self.assertIn(("state", 1, {"state": "listening"}), events.events)
        self.assertFalse(any(kind in {"error", "done"} for kind, _, _ in events.events))
        await call.aclose()

    async def test_voice_barge_in_cancels_prior_llm_and_drops_its_history(self):
        audio, events = Audio(), CallEvents()
        captured = []
        closed = asyncio.Event()
        hold = asyncio.Event()

        async def fake_reply(_config, _http, messages):
            captured.append(messages)
            if len(captured) == 1:
                try:
                    yield "先说一小句。"
                    await hold.wait()
                    yield "这段旧回复不能出现。"
                finally:
                    closed.set()
            else:
                yield "这是新回复。"

        async def fake_tts(*_args, **_kwargs):
            yield b"\0" * 960

        worker = Conversation(audio, events, object(), object(), SimpleNamespace(max_text_length=90), object(), "fixed")
        with patch("gemini_worker.stream_reply", fake_reply), patch("gemini_worker.iter_pcm", fake_tts):
            worker.handle_text("old")
            await asyncio.wait_for(audio.got.wait(), 1)
            for _ in range(15):
                worker.handle_audio(LOUD)
            self.assertTrue(any(kind == "interrupted" and turn == 1 for kind, turn, _ in events.events))
            await asyncio.wait_for(closed.wait(), 1)
            for _ in range(20):
                worker.handle_audio(SILENCE)
            await asyncio.sleep(0)
            self.assertFalse(events.finished.is_set(), "playout still not drained")
            audio.drain.set()
            await asyncio.wait_for(events.finished.wait(), 1)
            await worker.aclose()

        self.assertEqual([x for x in events.events if x[0] == "done"], [("done", 2, {"text": "这是新回复。"})])
        self.assertIn(("user", 2, {"input": "voice"}), events.events)
        self.assertGreater(audio.clears, 0)
        self.assertEqual(len(captured[1]), 2)
        self.assertEqual(captured[1][0], {"role": "system", "content": "fixed"})
        self.assertEqual(captured[1][-1]["content"][0]["type"], "input_audio")

    async def test_server_event_contract_excludes_orphan_delta_and_raw_input(self):
        http = HTTP()
        events = Events(None, ROOM, "pilot-user-a", http, ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event())
        events.send("delta", 1, text="live only")
        events.send("user", 1, input="voice")
        events.send("error", 1, code="gemini_http")
        events.send("closed", 1)
        self.assertEqual(events.journal.qsize(), 3)
        voice = events.journal.get_nowait()
        self.assertEqual(voice, {"roomName": ROOM, "type": "user", "turn": 1, "input": "voice"})
        self.assertEqual(events.journal.get_nowait()["type"], "error")
        self.assertEqual(events.journal.get_nowait()["type"], "closed")


    async def test_asr_success_emits_final_transcript_and_only_text_to_model(self):
        audio, events = Audio(), CallEvents()
        audio.drain.set()
        calls = []
        prompt = "这是转写。"

        async def recognize(_asr, _http, body):
            self.assertIsInstance(body, bytes)
            self.assertGreaterEqual(len(body), 6400)
            self.assertFalse(any(kind == "user" for kind, _, _ in events.events))
            return prompt

        async def reply(_config, _http, messages, **options):
            calls.append(messages)
            self.assertEqual(options, {"text_only": True, "read_timeout": 65})
            self.assertTrue(all(isinstance(message["content"], str) for message in messages))
            yield "你好！"

        async def tts(*_args, **_kw):
            yield b"\0" * 960

        call = Conversation(audio, events, object(), object(), SimpleNamespace(max_text_length=90), object(),
                            "SOUL", asr=AsrConfig(ASR_ENDPOINT, "a" * 64))
        with patch("gemini_worker.transcribe", recognize), patch("gemini_worker.stream_reply", reply), patch(
            "gemini_worker.iter_pcm", tts,
        ):
            call._submit("voice", LOUD * 12)
            await asyncio.wait_for(events.finished.wait(), 1)
            self.assertIn(("state", 1, {"state": "transcribing"}), events.events)
            self.assertIn(("user", 1, {"input": "voice", "text": prompt}), events.events)
            self.assertEqual(calls[0][-1], {"role": "user", "content": prompt})
            events.finished.clear()
            call.handle_text("下面打字。")
            await asyncio.wait_for(events.finished.wait(), 1)
            self.assertEqual(calls[1][1], {"role": "user", "content": prompt})
            self.assertEqual(calls[1][-1], {"role": "user", "content": "下面打字。"})
            await call.aclose()

    async def test_asr_failures_do_not_invent_transcript_or_fall_back(self):
        for error, code in ((None, "asr_no_speech"), (GeminiError("asr_timeout"), "asr_timeout")):
            audio, events = Audio(), CallEvents()

            async def recognize(*_args):
                if error:
                    raise error
                return ""

            async def upstream(*_args, **_kw):
                self.fail("No provider fallback is allowed on ASR failure")
                yield ""

            call = Conversation(audio, events, object(), object(), SimpleNamespace(max_text_length=90), object(),
                                "SOUL", asr=AsrConfig(ASR_ENDPOINT, "a" * 64))
            with patch("gemini_worker.transcribe", recognize), patch("gemini_worker.stream_reply", upstream):
                call._submit("voice", LOUD * 12)
                await asyncio.wait_for(call.active, 1)
                await call.aclose()
            self.assertIn(("user", 1, {"input": "voice"}), events.events)
            self.assertIn(("error", 1, {"code": code}), events.events)
            self.assertFalse(any(kind == "done" for kind, _, _ in events.events))

    async def test_new_speech_cancels_pending_asr_and_never_publishes_old_transcript(self):
        audio, events = Audio(), CallEvents()
        audio.drain.set()
        started, cancelled = asyncio.Event(), asyncio.Event()
        count = 0

        async def recognize(*_args):
            nonlocal count
            count += 1
            if count == 1:
                try:
                    started.set()
                    await asyncio.Future()
                finally:
                    cancelled.set()
            return "新的声音。"

        async def reply(_config, _http, messages, **_kw):
            self.assertEqual(messages[-1]["content"], "新的声音。")
            yield "听到了。"

        async def tts(*_args, **_kw):
            yield b"\0" * 960

        call = Conversation(audio, events, object(), object(), SimpleNamespace(max_text_length=90), object(),
                            "SOUL", asr=AsrConfig(ASR_ENDPOINT, "a" * 64))
        with patch("gemini_worker.transcribe", recognize), patch("gemini_worker.stream_reply", reply), patch(
            "gemini_worker.iter_pcm", tts,
        ):
            call._submit("voice", LOUD * 12)
            await asyncio.wait_for(started.wait(), 1)
            for _ in range(15):
                call.handle_audio(LOUD)
            await asyncio.wait_for(cancelled.wait(), 1)
            for _ in range(20):
                call.handle_audio(SILENCE)
            await asyncio.wait_for(events.finished.wait(), 1)
            await call.aclose()
        self.assertEqual([item for item in events.events if item[0] == "user"], [
            ("user", 1, {"input": "voice"}),
            ("user", 2, {"input": "voice", "text": "新的声音。"}),
        ])
        self.assertIn(("interrupted", 1, {}), events.events)
        self.assertEqual([turn for kind, turn, _ in events.events if kind == "done"], [2])

    async def test_native_journal_coalesces_deltas_after_user_without_browser_changes(self):
        seen = []
        entered, resume, coalesced = asyncio.Event(), asyncio.Event(), asyncio.Event()

        class Sink:
            def post(self, _url, **kwargs):
                item = json.loads(kwargs["data"])

                class Response:
                    async def __aenter__(self):
                        seen.append(item)
                        if item.get("text") == "a":
                            entered.set()
                            await resume.wait()
                        if item.get("text") == "bc":
                            coalesced.set()
                        return SimpleNamespace(status=200)

                    async def __aexit__(self, *_exc):
                        pass

                return Response()

        events = Events(None, ROOM, "pilot-user-a", Sink(), ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event())
        with patch("gemini_worker.JOURNAL_DELTA_INTERVAL", 0.015):
            worker = asyncio.create_task(events.persist())
            try:
                events.send("user", 1, input="voice", text="verified transcript")
                events.send("delta", 1, text="a")
                await asyncio.wait_for(entered.wait(), 1)
                events.send("delta", 1, text="b")
                events.send("delta", 1, text="c")
                self.assertTrue(events.journal.empty(), "Only one delta may be in flight")
                resume.set()
                await asyncio.wait_for(coalesced.wait(), 1)
                events.send("done", 1, text="abcd")
                await asyncio.wait_for(events.journal.join(), 1)
            finally:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
        self.assertEqual([(obj["type"], obj.get("text")) for obj in seen], [
            ("user", "verified transcript"), ("delta", "a"), ("delta", "bc"), ("done", "abcd"),
        ])
        self.assertEqual(seen[1], {"roomName": ROOM, "type": "delta", "turn": 1, "text": "a"})
        self.assertEqual(events.browser.qsize(), 5, "Browser packets remain independent")
        self.assertFalse(events.ended.is_set())

    async def test_native_journal_delta_timeout_falls_back_to_final(self):
        seen = []
        entered = asyncio.Event()

        class Sink:
            def post(self, _url, **kwargs):
                kind = json.loads(kwargs["data"])["type"]

                class Response:
                    async def __aenter__(self):
                        seen.append(kind)
                        if kind == "delta":
                            entered.set()
                            await asyncio.Future()
                        return SimpleNamespace(status=200)

                    async def __aexit__(self, *_exc):
                        pass

                return Response()

        events = Events(None, ROOM, "pilot-user-a", Sink(), ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event())
        with patch("gemini_worker.JOURNAL_DELTA_TIMEOUT", 0.03):
            worker = asyncio.create_task(events.persist())
            try:
                events.send("user", 1, input="voice")
                events.send("delta", 1, text="slow")
                await asyncio.wait_for(entered.wait(), 1)
                await asyncio.wait_for(events.journal.join(), 1)
                events.send("delta", 1, text="no retry")
                events.send("done", 1, text="slow no retry")
                await asyncio.wait_for(events.journal.join(), 1)
            finally:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
        self.assertEqual(seen, ["user", "delta", "done"])
        self.assertFalse(events.journal_failed)
        self.assertFalse(events.ended.is_set())

    async def test_native_journal_drops_unsent_stale_and_oversized_fragments(self):
        seen = []

        class Sink(HTTP):
            def post(self, url, **kwargs):
                seen.append(json.loads(kwargs["data"]))
                return super().post(url, **kwargs)

        events = Events(None, ROOM, "pilot-user-a", Sink(), ("http://127.0.0.1:18793/events", "fixture"), asyncio.Event())
        events.send("user", 1, input="voice")
        events.send("delta", 1, text="unsent")
        events.send("interrupted", 1)
        events.send("delta", 1, text="stale")
        events.send("user", 2, input="voice")
        events.send("delta", 2, text="😀" * 257)
        events.send("delta", 2, text="not a contiguous prefix")
        events.send("done", 2, text="new final")
        worker = asyncio.create_task(events.persist())
        try:
            await asyncio.wait_for(events.journal.join(), 1)
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        self.assertEqual([(obj["type"], obj["turn"]) for obj in seen], [
            ("user", 1), ("interrupted", 1), ("user", 2), ("done", 2),
        ])
        self.assertFalse(events.ended.is_set())

if __name__ == "__main__":
    unittest.main()
