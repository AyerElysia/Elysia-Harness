"""Voice -> Breeze worker; main DSH mode uses local ASR and no raw recording."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import deque
from contextlib import aclosing
from dataclasses import dataclass

import aiohttp
from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, JobExecutorType, JobRequest, cli

from agent import JOIN_SECONDS, MAX_JOB_SECONDS, SOUL_ENV, read_soul
from breeze_tts import SAMPLE_RATE, BreezeSettings, BreezeStreamError, iter_pcm
from gemini_cascade import (
    FRAME_MS, INPUT_RATE, MAX_INPUT_TEXT_BYTES, MAX_OUTPUT_CHARS, AsrConfig, ClauseBuffer, EnergyTurns, GeminiConfig,
    GeminiError, stream_reply, transcribe, validate_voice_route, wav_input,
)

AGENT_NAME = "elysia-gemini-cascade-pilot"
ROOM_NAME = re.compile(r"(?:elysia-voice-pilot|elysia-gemini-cascade)-[a-f0-9]{32}\Z")
IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,96}\Z")
INPUT_TOPIC = "elysia.cascade.input.v1"
EVENT_TOPIC = "elysia.cascade.events.v1"
EVENTS_URL = "http://127.0.0.1:18793/events"
MAX_TURNS = 64
JOURNAL_DELTA_INTERVAL = 0.2
JOURNAL_DELTA_TIMEOUT = 0.5
JOURNAL_DELTA_UNITS = 512
JOURNAL_DELTA_COUNT = 24
MAIN_TURN_MODE = "main-session"
NATIVE_REPLY_SECONDS = 180
NATIVE_POLL_INTERVAL = 0.3
MAX_NATIVE_RESPONSE_BYTES = 32_768


def dispatch_target(room: str, metadata: str) -> tuple[str, str | None] | None:
    if not ROOM_NAME.fullmatch(room) or not metadata or len(metadata) > 256:
        return None
    try:
        obj = json.loads(metadata)
        if not isinstance(obj, dict):
            return None
        value = obj.get("participantIdentity")
        if not isinstance(value, str) or not IDENTITY.fullmatch(value):
            return None
        if set(obj) == {"participantIdentity"}:
            return value, None
        if (
            room.startswith("elysia-gemini-cascade-")
            and set(obj) == {"participantIdentity", "turnMode"} and obj["turnMode"] == MAIN_TURN_MODE
        ):
            return value, MAIN_TURN_MODE
    except (ValueError, RecursionError):
        pass
    return None


def dispatch_identity(room: str, metadata: str) -> str | None:
    target = dispatch_target(room, metadata)
    return target[0] if target is not None else None


def parse_input(payload: bytes) -> str | None:
    if not payload or len(payload) > MAX_INPUT_TEXT_BYTES + 70:
        return None
    try:
        obj = json.loads(payload.decode("utf-8"))
        if not isinstance(obj, dict) or set(obj) != {"type", "text"} or obj["type"] != "text":
            return None
        value = obj["text"]
        if isinstance(value, str) and len(value.encode("utf-8")) <= MAX_INPUT_TEXT_BYTES:
            return value.strip() or None
    except (ValueError, RecursionError):
        pass
    return None


def event_sink() -> tuple[str, str] | None:
    url, key = os.environ.get("GEMINI_CASCADE_EVENTS_URL"), os.environ.get("GEMINI_CASCADE_EVENTS_KEY")
    if not url and not key:
        return None
    if url != EVENTS_URL or key is None or not re.fullmatch(r"[!-~]{24,512}", key):
        raise ValueError("cascade_event_sink_invalid")
    return url, key


@dataclass(slots=True)
class _JournalDraft:
    turn: int
    pending: str = ""
    sent: int = 0
    disabled: bool = False


class Events:
    """Queues isolate media from caption delivery; only the worker can write DSH events."""

    def __init__(self, room, room_name, identity, http, sink, ended, *, turn_mode: str | None = None):
        self.room, self.room_name, self.identity = room, room_name, identity
        self.http, self.sink, self.ended = http, sink, ended
        self.turn_mode = turn_mode
        self.browser: asyncio.Queue = asyncio.Queue(maxsize=128)
        self.journal: asyncio.Queue = asyncio.Queue(maxsize=MAX_TURNS * 2 + 3)
        self.journal_failed = False
        # One optional delta may use the extra slot; it cannot displace a user
        # or terminal event, or block the speech synthesis queue.
        self._draft: _JournalDraft | None = None
        self._delta_busy = False
        self._next_delta = 0.0
        self._delta_timer: asyncio.TimerHandle | None = None

    def _cancel_delta_timer(self) -> None:
        if self._delta_timer is not None:
            self._delta_timer.cancel()
            self._delta_timer = None

    def _drop_draft(self) -> None:
        self._cancel_delta_timer()
        self._draft = None

    def _disable_delta(self, turn: int) -> None:
        if self._draft is not None and self._draft.turn == turn:
            self._cancel_delta_timer()
            self._draft.disabled = True
            self._draft.pending = ""

    def _stage_delta(self, turn: int, text: object) -> None:
        draft = self._draft
        if draft is None or draft.turn != turn or draft.disabled or not isinstance(text, str) or not text:
            return
        # After a dropped fragment, stop this draft instead of sending a
        # discontinuous prefix. Authoritative done still carries the full text.
        if draft.sent >= JOURNAL_DELTA_COUNT or len(text) > JOURNAL_DELTA_UNITS:
            self._disable_delta(turn)
            return
        value = draft.pending + text
        try:
            if len(value.encode("utf-16-le")) > JOURNAL_DELTA_UNITS * 2:
                self._disable_delta(turn)
                return
        except UnicodeEncodeError:
            self._disable_delta(turn)
            return
        draft.pending = value
        self._pump_delta()

    def _pump_delta(self) -> None:
        draft = self._draft
        if (
            self.journal_failed or self._delta_busy or draft is None or draft.disabled
            or not draft.pending or self.journal.qsize() >= 2
        ):
            return
        loop = asyncio.get_running_loop()
        now = loop.time()
        if now < self._next_delta:
            if self._delta_timer is None:
                self._delta_timer = loop.call_at(self._next_delta, self._on_delta_timer)
            return
        self._cancel_delta_timer()
        self.journal.put_nowait({"roomName": self.room_name, "type": "delta", "turn": draft.turn, "text": draft.pending})
        draft.pending = ""
        draft.sent += 1
        self._delta_busy = True
        self._next_delta = now + JOURNAL_DELTA_INTERVAL

    def _on_delta_timer(self) -> None:
        self._delta_timer = None
        self._pump_delta()

    def send(self, kind: str, turn: int, **fields) -> None:
        obj = {"type": kind, "turn": turn, **fields}
        if self.browser.full() and kind != "delta":
            # A final result carries the complete string even if a delta was dropped.
            self.browser.get_nowait()
            self.browser.task_done()
        if not self.browser.full():
            self.browser.put_nowait(obj)
        if self.sink is None or self.journal_failed:
            return
        if self.turn_mode == MAIN_TURN_MODE:
            # The ASR submission is sent by native_reply before polling;
            # DSH owns all history and deltas. The journal just detaches audio.
            if kind == "error" and fields.get("code") not in {"voice_session_sync_failed", "voice_turn_limit"}:
                obj = {"type": "interrupted", "turn": turn}
            elif kind not in {"interrupted", "closed"}:
                return
            if self.journal.full():
                self.journal_failed = True
                self.ended.set()
                return
            self.journal.put_nowait({"roomName": self.room_name, **obj})
            return
        if kind == "delta":
            self._stage_delta(turn, fields.get("text"))
            return
        essential = kind in {"user", "done", "interrupted", "closed"} or (
            kind == "error" and fields.get("code") not in {"voice_session_sync_failed", "voice_turn_limit"}
        )
        if not essential:
            return
        if kind == "user":
            self._drop_draft()
            self._draft = _JournalDraft(turn)
        elif kind == "closed" or (self._draft is not None and self._draft.turn == turn):
            self._drop_draft()
        if self.journal.full():
            self._drop_draft()
            self.journal_failed = True
            self.ended.set()
            return
        self.journal.put_nowait({"roomName": self.room_name, **obj})

    async def _native_post(self, payload: dict, *, expect_data: bool = False) -> dict | None:
        if self.sink is None:
            raise GeminiError("voice_main_turn_failed")
        url, key = self.sink
        try:
            async with self.http.post(
                url, json={"roomName": self.room_name, **payload}, allow_redirects=False,
                headers={
                    "Authorization": "Bearer " + key, "Accept": "application/json", "Accept-Encoding": "identity",
                },
                auto_decompress=False, timeout=aiohttp.ClientTimeout(total=5, connect=2, sock_read=4),
            ) as response:
                if not 200 <= response.status < 300:
                    raise GeminiError("voice_main_turn_failed")
                if not expect_data:
                    return None
                mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if mime != "application/json" or response.headers.get("Content-Encoding", "identity") != "identity":
                    raise GeminiError("voice_main_turn_failed")
                body = bytearray()
                async for chunk in response.content.iter_chunked(2048):
                    body.extend(chunk)
                    if len(body) > MAX_NATIVE_RESPONSE_BYTES:
                        raise GeminiError("voice_main_turn_failed")
                result = json.loads(body.decode("utf-8"))
                if not isinstance(result, dict):
                    raise GeminiError("voice_main_turn_failed")
                return result
        except (aiohttp.ClientError, TimeoutError, ValueError, RecursionError):
            raise GeminiError("voice_main_turn_failed") from None

    async def native_reply(self, turn: int, transcript: str):
        """Forward only final local ASR text; never retry a possibly accepted input."""
        if self.turn_mode != MAIN_TURN_MODE or not transcript.strip():
            raise GeminiError("voice_main_turn_failed")
        await self._native_post({"type": "user", "turn": turn, "input": "voice", "text": transcript})
        seq = 0
        units = 0
        while True:
            reply = await self._native_post({"type": "poll", "turn": turn, "seq": seq}, expect_data=True)
            if reply is None or reply.keys() - {"seq", "text", "done", "error"} or reply.get("error"):
                raise GeminiError("voice_main_turn_failed")
            next_seq, fragment, done = reply.get("seq"), reply.get("text"), reply.get("done")
            if type(next_seq) is not int or type(done) is not bool or not isinstance(fragment, str):
                raise GeminiError("voice_main_turn_failed")
            try:
                delta_units = len(fragment.encode("utf-16-le")) // 2
            except UnicodeError:
                raise GeminiError("voice_main_turn_failed") from None
            if (
                next_seq != seq + delta_units
                or units + delta_units > MAX_OUTPUT_CHARS
                or any(ord(char) < 32 and char not in "\t\n\r" for char in fragment)
            ):
                raise GeminiError("voice_main_turn_failed")
            units += delta_units
            seq = next_seq
            if fragment:
                yield fragment
            if done:
                return
            await asyncio.sleep(NATIVE_POLL_INTERVAL)

    async def publish(self) -> None:
        while True:
            obj = await self.browser.get()
            try:
                async with asyncio.timeout(0.75):
                    await self.room.local_participant.publish_data(
                        json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                        destination_identities=[self.identity], reliable=True, topic=EVENT_TOPIC,
                    )
            except Exception:
                # No participant metadata, text, or raw SDK exception goes to logs.
                pass
            finally:
                self.browser.task_done()

    async def persist(self) -> None:
        if self.sink is None:
            return
        url, key = self.sink
        try:
            while True:
                obj = await self.journal.get()
                optional = obj["type"] == "delta"
                try:
                    if optional and (
                        self._draft is None or self._draft.turn != obj["turn"] or self._draft.disabled
                    ):
                        # An unsent draft must not delay a completed or interrupted turn.
                        continue
                    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    timeout = JOURNAL_DELTA_TIMEOUT if optional else 2
                    async with asyncio.timeout(timeout), self.http.post(
                        url, data=body, allow_redirects=False,
                        headers={
                            "Authorization": "Bearer " + key, "Content-Type": "application/json",
                        },
                        timeout=aiohttp.ClientTimeout(total=timeout),
                    ) as response:
                        if not 200 <= response.status < 300:
                            raise RuntimeError()
                except Exception:
                    if optional:
                        # A slow or older sink cannot close the call or lose the final text.
                        self._disable_delta(obj["turn"])
                        continue
                    if self.turn_mode == MAIN_TURN_MODE:
                        # Only audio detachment, never a model action. Local playout
                        # is already cancelled; a later utterance may still work.
                        continue
                    self.journal_failed = True
                    self.send("error", obj["turn"], code="voice_session_sync_failed")
                    self.ended.set()
                    return
                finally:
                    self.journal.task_done()
                    if optional:
                        self._delta_busy = False
                    self._pump_delta()
        finally:
            self._drop_draft()


class Conversation:
    """A single selected caller, one generation at a time, with a hard stop per epoch."""

    def __init__(
        self, source, events, gemini, gemini_http, breeze, breeze_http, soul,
        *, asr: AsrConfig | None = None, turn_mode: str | None = None,
    ):
        self.source, self.events = source, events
        self.gemini, self.gemini_http = gemini, gemini_http
        self.asr = asr
        self.turn_mode = turn_mode
        if self.turn_mode == MAIN_TURN_MODE and asr is None:
            raise GeminiError("voice_main_asr_required")
        self.breeze, self.breeze_http, self.soul = breeze, breeze_http, soul
        self.history: deque[tuple[dict, dict]] = deque(maxlen=8)
        self.turn = 0
        self.active: asyncio.Task | None = None
        self.settled = 0
        self.user_announced = False
        self.tasks: set[asyncio.Task] = set()
        self.closed = False
        self.playing = False
        self.last_text_at = -100.0
        self.detector = EnergyTurns()

    def _stop_active(self, *, announce: bool) -> None:
        if self.active is not None and not self.active.done():
            self.active.cancel()
            self.active = None
            self.playing = False
            self.source.clear_queue()
            if announce and self.settled < self.turn:
                # During ASR an interrupted voice turn has no verified transcript.
                if not self.user_announced and self.turn_mode != MAIN_TURN_MODE:
                    self._announce_user("voice")
                self.settled = self.turn
                self.events.send("interrupted", self.turn)
                self.events.send("state", self.turn, state="listening")

    def handle_audio(self, pcm: bytes) -> None:
        if self.closed:
            return
        started, complete = self.detector.feed(pcm, playback=self.playing)
        if started:
            self._stop_active(announce=True)
        if complete is not None:
            self._submit("voice", complete)

    def handle_text(self, value: str) -> None:
        now = asyncio.get_running_loop().time()
        if self.turn_mode == MAIN_TURN_MODE or self.closed or self.detector.speaking or now - self.last_text_at < 0.35:
            return
        self.last_text_at = now
        self._submit("text", value)

    def _announce_user(self, kind: str, text: str | None = None) -> None:
        if self.user_announced:
            return
        self.user_announced = True
        if text is None:
            self.events.send("user", self.turn, input=kind)
        else:
            self.events.send("user", self.turn, input=kind, text=text)

    def _submit(self, kind: str, value: bytes | str) -> None:
        if self.turn >= MAX_TURNS:
            self.events.send("error", self.turn, code="voice_turn_limit")
            self.events.ended.set()
            return
        self._stop_active(announce=True)
        self.turn += 1
        self.user_announced = False
        if kind == "voice" and self.asr is not None:
            self.events.send("state", self.turn, state="transcribing")
        else:
            self._announce_user(kind, value if isinstance(value, str) else None)
            self.events.send("state", self.turn, state="thinking")
        self.active = asyncio.create_task(self._respond(self.turn, kind, value, tuple(self.tasks)))
        self.tasks.add(self.active)
        self.active.add_done_callback(self.tasks.discard)

    async def _respond(self, turn: int, kind: str, value: bytes | str, prior: tuple[asyncio.Task, ...]) -> None:
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=5)
        parts: list[str] = []
        workers: list[asyncio.Task] = []
        messages: list[dict] = []
        transcript: str | None = None
        native = self.turn_mode == MAIN_TURN_MODE

        def require_current() -> None:
            if self.closed or self.turn != turn or self.settled >= turn or self.active is None or self.active.cancelling():
                raise asyncio.CancelledError()

        async def produce() -> None:
            phrases = ClauseBuffer(self.breeze.max_text_length)
            pending = ""
            if native:
                if transcript is None:
                    raise GeminiError("voice_main_turn_failed")
                upstream = self.events.native_reply(turn, transcript)
            elif self.asr is not None:
                upstream = stream_reply(self.gemini, self.gemini_http, messages, text_only=True, read_timeout=65)
            else:
                upstream = stream_reply(self.gemini, self.gemini_http, messages)
            async with aclosing(upstream) as stream:
                async for fragment in stream:
                    require_current()
                    parts.append(fragment)
                    pending += fragment
                    clauses = phrases.push(fragment)
                    if clauses or len(pending) >= 28 or len(parts) == 1:
                        self.events.send("delta", turn, text=pending)
                        pending = ""
                    for clause in clauses:
                        await queue.put(clause)
            require_current()
            if pending:
                self.events.send("delta", turn, text=pending)
            remainder = phrases.finish()
            if remainder:
                await queue.put(remainder)
            await queue.put(None)

        async def speak() -> None:
            while (phrase := await queue.get()) is not None:
                async with aclosing(iter_pcm(self.breeze, phrase, self.breeze_http, timeout_seconds=28)) as pcm:
                    async for frame in pcm:
                        require_current()
                        if not self.playing:
                            self.playing = True
                            self.events.send("state", turn, state="speaking")
                        await self.source.capture_frame(rtc.AudioFrame(frame, SAMPLE_RATE, 1, len(frame) // 2))
            await self.source.wait_for_playout()

        try:
            if prior:
                # Shield the old cleanup from a second barge-in while this task waits.
                # The prior task was already cancelled, so await it without forwarding
                # CancelledError from its expected terminal result to this response.
                await asyncio.shield(asyncio.gather(*prior, return_exceptions=True))
                self.source.clear_queue()
            require_current()
            if kind == "voice":
                if not isinstance(value, bytes):
                    raise GeminiError("asr_failed" if self.asr is not None else "gemini_invalid_audio")
                if self.asr is not None:
                    transcript = await transcribe(self.asr, self.breeze_http, value)
                    value = b""  # No raw audio is retained or sent outside the private ASR leg.
                    require_current()
                    if not transcript:
                        raise GeminiError("asr_no_speech")
                    self._announce_user("voice", transcript)
                    self.events.send("state", turn, state="thinking")
                    current = {"role": "user", "content": transcript}
                else:
                    current = {"role": "user", "content": [wav_input(value)]}
            else:
                current = {"role": "user", "content": value}
            if not native:
                messages.append({"role": "system", "content": self.soul})
                messages.extend(item for pair in self.history for item in pair)
                messages.append(current)
            async with asyncio.timeout(NATIVE_REPLY_SECONDS if native else 90):
                workers = [asyncio.create_task(produce()), asyncio.create_task(speak())]
                await asyncio.gather(*workers)
            require_current()
            full = "".join(parts).strip()
            if not full and not native:
                raise GeminiError("gemini_incomplete_reply")
            if not native:
                # Retain only current-call, confirmed text. Prior raw voice cannot be replayed.
                user = current if isinstance(current["content"], str) else {"role": "user", "content": "[语音发言未保留转写]"}
                self.history.append((user, {"role": "assistant", "content": full}))
            self.playing = False
            self.settled = turn
            if full:
                self.events.send("done", turn, text=full)
            self.events.send("state", turn, state="listening")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            require_current()
            if not self.user_announced and not native:
                self._announce_user("voice")
            self.settled = turn
            self.playing = False
            self.source.clear_queue()
            code = error.code if isinstance(error, GeminiError) else "breeze_failed" if isinstance(
                error, BreezeStreamError,
            ) else "voice_main_turn_timeout" if native and isinstance(error, TimeoutError) else "cascade_reply_failed"
            self.events.send("error", turn, code=code)
            self.events.send("state", turn, state="listening")
        finally:
            for worker in workers:
                if not worker.done():
                    worker.cancel()
            if workers:
                await asyncio.gather(*workers, return_exceptions=True)
            # A failed provider may have emitted text before its terminal error; no
            # partial history is appended, and queued audio is never resumed.

    async def aclose(self) -> None:
        self.closed = True
        self.detector.reset()
        self._stop_active(announce=True)
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.source.clear_queue()
        self.history.clear()


async def _request(req: JobRequest) -> None:
    if dispatch_identity(req.job.room.name, req.job.metadata) is None:
        await req.reject()
        return
    await req.accept(name="爱莉 · Gemini 通话试验")


server = AgentServer(
    job_executor_type=JobExecutorType.PROCESS,
    host="127.0.0.1",
    port=18792,
    num_idle_processes=0,
    load_fnc=lambda worker: float(len(worker.active_jobs)),
    load_threshold=1.0,
    drain_timeout=10,
    shutdown_process_timeout=15,
    session_end_timeout=10,
    log_level="WARN",
)


@server.rtc_session(agent_name=AGENT_NAME, on_request=_request)
async def run(ctx: JobContext) -> None:
    logging.disable(logging.CRITICAL)
    room_name = ctx.job.room.name
    target = dispatch_target(room_name, ctx.job.metadata)
    if target is None:
        ctx.shutdown(reason="cascade_invalid_dispatch")
        return
    identity, turn_mode = target
    native = turn_mode == MAIN_TURN_MODE
    ended = asyncio.Event()
    source: rtc.AudioSource | None = None
    stream: rtc.AudioStream | None = None
    call: Conversation | None = None
    input_task: asyncio.Task | None = None
    out_tasks: list[asyncio.Task] = []
    events: Events | None = None
    reason = "cascade_closed"
    local: aiohttp.ClientSession | None = None
    upstream: aiohttp.ClientSession | None = None

    def on_leave(participant: rtc.RemoteParticipant) -> None:
        if participant.identity == identity:
            ended.set()

    def on_disconnect(*_args: object) -> None:
        ended.set()

    def on_packet(packet: rtc.DataPacket) -> None:
        if (
            call is None or ended.is_set() or packet.topic != INPUT_TOPIC
            or packet.participant is None or packet.participant.identity != identity
            or packet.participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
        ):
            return
        if (text := parse_input(packet.data)) is not None:
            call.handle_text(text)

    def on_muted(publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if call is not None and participant.identity == identity and publication.source == rtc.TrackSource.SOURCE_MICROPHONE:
            call.detector.reset()

    async def capture() -> None:
        assert stream is not None and call is not None
        try:
            async for event in stream:
                frame = event.frame
                if frame.sample_rate == INPUT_RATE and frame.num_channels == 1:
                    call.handle_audio(bytes(frame.data.cast("B")))
        except Exception:
            ended.set()

    ctx.room.on("participant_disconnected", on_leave)
    ctx.room.on("disconnected", on_disconnect)
    ctx.room.on("data_received", on_packet)
    ctx.room.on("track_muted", on_muted)
    try:
        async with asyncio.timeout(MAX_JOB_SECONDS):
            async with asyncio.timeout(JOIN_SECONDS):
                asr = AsrConfig.from_env()
                sink = event_sink()
                if native:
                    if asr is None or sink is None:
                        raise GeminiError("voice_main_asr_required")
                    gemini, soul = None, ""
                else:
                    gemini = GeminiConfig.from_env()
                    validate_voice_route(gemini, asr)
                    soul = await asyncio.to_thread(read_soul, os.environ.get(SOUL_ENV, ""))
                breeze = await asyncio.to_thread(BreezeSettings.from_config)
                await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
                participant = await ctx.wait_for_participant(
                    identity=identity, kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
                )
                if ended.is_set() or identity not in ctx.room.remote_participants:
                    return
                local = aiohttp.ClientSession(trust_env=False)
                if not native:
                    upstream = aiohttp.ClientSession(trust_env=False)
                source = rtc.AudioSource(SAMPLE_RATE, 1, queue_size_ms=80)
                track = rtc.LocalAudioTrack.create_audio_track("elysia-breeze", source)
                await ctx.room.local_participant.publish_track(
                    track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )
                stream = rtc.AudioStream.from_participant(
                    participant=participant, track_source=rtc.TrackSource.SOURCE_MICROPHONE,
                    capacity=50, sample_rate=INPUT_RATE, num_channels=1, frame_size_ms=FRAME_MS,
                )
                events = Events(ctx.room, room_name, identity, local, sink, ended, turn_mode=turn_mode)
                call = Conversation(source, events, gemini, upstream, breeze, local, soul, asr=asr, turn_mode=turn_mode)
                out_tasks = [asyncio.create_task(events.publish()), asyncio.create_task(events.persist())]
                input_task = asyncio.create_task(capture())
                events.send("state", 0, state="listening")
                print("cascade_ready", flush=True)
            await ended.wait()
    except TimeoutError:
        reason = "cascade_deadline"
    except asyncio.CancelledError:
        reason = "cascade_cancelled"
        raise
    except Exception:
        reason = "cascade_failed"
    finally:
        ctx.room.off("participant_disconnected", on_leave)
        ctx.room.off("disconnected", on_disconnect)
        ctx.room.off("data_received", on_packet)
        ctx.room.off("track_muted", on_muted)
        try:
            async with asyncio.timeout(5):
                if input_task is not None:
                    input_task.cancel()
                    await asyncio.gather(input_task, return_exceptions=True)
                if call is not None:
                    await call.aclose()
                if events is not None:
                    events.send("state", call.turn if call else 0, state="closed")
                    events.send("closed", call.turn if call else 0)
                    async with asyncio.timeout(2.5):
                        await asyncio.gather(events.journal.join(), events.browser.join())
        except TimeoutError:
            print("cascade_close_event_timeout", flush=True)
        finally:
            for task in out_tasks:
                task.cancel()
            await asyncio.gather(*out_tasks, return_exceptions=True)
            for resource, method in ((stream, "aclose"), (source, "aclose"), (upstream, "close"), (local, "close")):
                if resource is not None:
                    try:
                        async with asyncio.timeout(1):
                            await getattr(resource, method)()
                    except Exception:
                        print("cascade_cleanup_unconfirmed", flush=True)
            if events is not None and events.journal_failed:
                reason = "cascade_session_sync_failed"
            print(reason, flush=True)
            ctx.shutdown(reason=reason)


if __name__ == "__main__":
    cli.run_app(server)
