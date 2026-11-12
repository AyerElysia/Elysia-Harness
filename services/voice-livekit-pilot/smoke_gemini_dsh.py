"""Operator-only DSH preview smoke: an in-memory flite prompt, real model, no mic."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import stat
from dataclasses import dataclass

import aiohttp
from livekit import rtc

from breeze_tts import SAMPLE_RATE
from gemini_cascade import FRAME_MS, INPUT_FRAME_BYTES, INPUT_RATE, EnergyTurns

ORIGIN = "http://127.0.0.1:18795"
PREFIX = ORIGIN + "/api/elysia-gemini-cascade/"
SESSION_ID = "elysia-gemini-cascade"
MEDIA = "ws://127.0.0.1:18780"
TOPIC = "elysia.cascade.events.v1"
PROMPT = "Please tell me what nine plus five is in English."
LONG_PROMPT = "Please count out loud from one to fifty slowly."
BARGE_PROMPT = "Please add four to your first answer."
LOG_PATH = re.compile(r"/tmp/elyharn-gemini-cascade\.[A-Za-z0-9]{8}/dsh-preview(?:-v[0-9]{1,3})?\.log\Z")
LOGIN = re.compile(rb"http://127\.0\.0\.1:18795/\?token=([A-Za-z0-9._~%+=-]{12,512})(?=[^A-Za-z0-9._~%+=-]|$)")
ROOM = re.compile(r"elysia-gemini-cascade-[a-f0-9]{32}\Z")
ID = re.compile(r"pilot-user-[a-f0-9]{24}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
CODE = re.compile(r"[a-z0-9_]{1,64}\Z")
DSH_HEADERS = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}


class SmokeError(RuntimeError):
    pass


def login_token(path: Path) -> str:
    if not LOG_PATH.fullmatch(str(path)):
        raise SmokeError("preview_log_required")
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise SmokeError("preview_log_not_private")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 262_144:
            raise SmokeError("preview_log_not_private")
        found = list(LOGIN.finditer(stream.read(262_145)))
        if not found:
            raise SmokeError("preview_login_missing")
        return found[-1].group(1).decode("ascii")


def parse_start(obj, mode: str) -> tuple[str, str, str, str]:
    if not isinstance(obj, dict):
        raise SmokeError("invalid_start_response")
    if obj.get("inputMode") != mode:
        raise SmokeError("preview_start_mode_mismatch")
    room, server, identity, participant, call = (
        obj.get(name) for name in ("roomName", "serverUrl", "participantIdentity", "participantToken", "callToken")
    )
    if (
        not isinstance(room, str) or not ROOM.fullmatch(room) or server != MEDIA
        or not isinstance(identity, str) or not ID.fullmatch(identity)
        or not isinstance(participant, str) or not 32 <= len(participant) <= 8_192
        or not isinstance(call, str) or not HEX.fullmatch(call)
    ):
        raise SmokeError("invalid_start_response")
    return room, identity, participant, call


def expected(text: str, turn: int = 1) -> bool:
    pattern = r"(?<!\d)18(?!\d)|\beighteen\b" if turn == 3 else r"(?<!\d)14(?!\d)|\bfourteen\b"
    return bool(re.search(pattern, text, re.IGNORECASE))


def expected_transcript(text: str, turn: int = 1) -> bool:
    patterns = {
        1: r"(?<!\d)(?:\bnine\b|9)\s*(?:plus|\+)\s*(?:\bfive\b|5)(?!\d)",
        2: r"\bcount\b.{0,70}(?<!\d)(?:50|\bfifty\b)(?!\d)",
        3: r"\badd\s*(?:4(?!\d)|four\b).{0,70}\b(?:first|1st)\s*answer\b",
    }
    return bool(re.search(patterns[turn], text, re.IGNORECASE))


@dataclass
class Turn:
    voice: bool = False
    transcript_matches: bool = False
    asr_started: float | None = None
    transcript_final: float | None = None
    thinking: float | None = None
    first_text: float | None = None
    speaking: float | None = None
    first_audio: float | None = None
    interrupted: float | None = None
    done: bool = False
    answer_matches: bool = False
    failure: str | None = None
    stale_events: int = 0
    frames: int = 0


def elapsed(start, mark):
    return round((mark - start) * 1000) if mark is not None and start is not None else None


class ObservedTurns:
    """Retain booleans/timestamps only, never the actual transcript or reply."""

    def __init__(self, mode: str, multi: bool) -> None:
        self.mode = mode
        self.turns = {number: Turn() for number in range(1, 4 if multi else 2)}
        self.updated = asyncio.Event()
        self.playing: int | None = None
        self.interrupt_residual: float | None = None
        self.late_audio = 0

    def packet(self, obj: dict, now: float) -> None:
        number = obj.get("turn")
        if type(number) is not int or number not in self.turns:
            return
        turn = self.turns[number]
        kind = obj.get("type")
        state = obj.get("state") if kind == "state" else None
        if turn.interrupted is not None and (kind in {"delta", "done"} or state == "speaking"):
            turn.stale_events += 1
        if kind == "user" and obj.get("input") == "voice":
            turn.voice = True
            if self.mode == "local-asr" and isinstance(obj.get("text"), str) and turn.transcript_final is None:
                turn.transcript_matches = expected_transcript(obj["text"], number)
                turn.transcript_final = now
        if state == "transcribing" and turn.asr_started is None:
            turn.asr_started = now
        if state == "thinking" and turn.thinking is None:
            turn.thinking = now
        if state == "speaking" and turn.interrupted is None:
            turn.speaking = turn.speaking if turn.speaking is not None else now
            self.playing = number
        if kind == "delta" and isinstance(obj.get("text"), str) and turn.first_text is None:
            turn.first_text = now
        if kind == "done" and isinstance(obj.get("text"), str):
            turn.done = True
            turn.answer_matches = expected(obj["text"], number)
        if kind == "interrupted" and turn.interrupted is None:
            turn.interrupted = now
        if kind == "error":
            code = obj.get("code")
            turn.failure = code if isinstance(code, str) and CODE.fullmatch(code) else "turn_failed"
        if kind in {"done", "interrupted", "error"} and self.playing == number:
            self.playing = None
        self.updated.set()

    def audio(self, now: float) -> None:
        if self.playing in self.turns:
            turn = self.turns[self.playing]
            turn.frames += 1
            turn.first_audio = turn.first_audio if turn.first_audio is not None else now
        if 2 in self.turns:
            second, third = self.turns[2], self.turns[3]
            if second.interrupted is not None and third.speaking is None:
                self.interrupt_residual = now
                if now - second.interrupted > 0.65:
                    self.late_audio += 1
        self.updated.set()

    async def wait(self, ready) -> None:
        while not ready():
            self.updated.clear()
            if not ready():
                await self.updated.wait()

    def voice_ok(self, number: int) -> bool:
        turn = self.turns[number]
        return turn.voice and (self.mode != "local-asr" or (
            turn.transcript_matches and turn.asr_started is not None and turn.transcript_final is not None
        ))

    def terminal(self, number: int) -> bool:
        turn = self.turns[number]
        return turn.done or turn.interrupted is not None or turn.failure is not None

    def completion(self, number: int) -> str:
        turn = self.turns[number]
        if turn.failure:
            return turn.failure
        if not turn.done:
            return "turn_interrupted"
        if not turn.answer_matches:
            return "unexpected_answer"
        if not self.voice_ok(number):
            return "transcript_evidence_missing_or_unexpected"
        if turn.first_text is None or turn.frames < 5:
            return "terminal_event_without_complete_media_evidence"
        return "match"

    def report(self, number: int) -> dict:
        turn = self.turns[number]
        return {
            "synthetic_voice": turn.voice,
            "matched_expected": turn.answer_matches,
            "nonzero_breeze_frames": turn.frames,
            "final_transcript_matched": turn.transcript_matches if self.mode == "local-asr" else None,
            "asr_to_final_ms": elapsed(turn.asr_started, turn.transcript_final),
            "thinking_to_first_text_ms": elapsed(turn.thinking, turn.first_text),
            "thinking_to_first_audio_ms": elapsed(turn.thinking, turn.first_audio),
            "interrupted": turn.interrupted is not None,
            "done": turn.done,
            "stale_events": turn.stale_events,
        }


async def synthetic_prompt(prompt: str = PROMPT) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
        "-i", f"flite=text='{prompt}':voice=slt", "-af", "volume=1.4",
        "-t", "10", "-ac", "1", "-ar", str(INPUT_RATE), "-f", "s16le", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(10):
            pcm, _ = await proc.communicate()
    except (TimeoutError, asyncio.CancelledError):
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    if proc.returncode or not INPUT_RATE < len(pcm) <= INPUT_RATE * 20 or len(pcm) % 2:
        raise SmokeError("flite_audio_failed")
    return pcm


def pcm_chunks(pcm: bytes):
    blank = bytes(INPUT_FRAME_BYTES)
    for _ in range(8):
        yield blank
    for index in range(0, len(pcm), INPUT_FRAME_BYTES):
        yield pcm[index:index + INPUT_FRAME_BYTES].ljust(INPUT_FRAME_BYTES, b"\0")
    for _ in range(36):
        yield blank


async def publish_pcm(source, pcm: bytes) -> None:
    end = asyncio.get_running_loop().time()
    for chunk in pcm_chunks(pcm):
        await source.capture_frame(rtc.AudioFrame(chunk, INPUT_RATE, 1, INPUT_FRAME_BYTES // 2))
        end += FRAME_MS / 1000
        await asyncio.sleep(max(0.0, end - asyncio.get_running_loop().time()))
    await source.wait_for_playout()


async def login(http: aiohttp.ClientSession, path: Path) -> None:
    # Use the private bootstrap in memory only. Never print headers or cookies.
    token = login_token(path)
    async with http.get(ORIGIN + "/?token=" + token, allow_redirects=False) as response:
        if response.status not in {200, 302, 303, 307, 308}:
            raise SmokeError("preview_login_rejected")


async def post(http: aiohttp.ClientSession, action: str, payload: dict) -> tuple[int, object]:
    async with http.post(PREFIX + action, json=payload, headers=DSH_HEADERS, allow_redirects=False) as response:
        body = bytearray()
        async for chunk in response.content.iter_chunked(4_096):
            body.extend(chunk)
            if len(body) > 16_384:
                raise SmokeError("preview_response_limit")
        try:
            value = json.loads(body)
        except (ValueError, RecursionError):
            value = None
        return response.status, value


async def run(path: Path, limit: int, expected_mode: str, *, multi: bool = False) -> dict:
    if multi and expected_mode != "local-asr":
        raise SmokeError("multi_turn_requires_local_asr")
    prompts = [await synthetic_prompt(prompt) for prompt in ((PROMPT, LONG_PROMPT, BARGE_PROMPT) if multi else (PROMPT,))]
    observed = ObservedTurns(expected_mode, multi)
    barge_started = None
    room = rtc.Room()
    source = rtc.AudioSource(INPUT_RATE, 1, queue_size_ms=80)
    loop = asyncio.get_running_loop()
    outgoing = None
    stream = None
    read_task = None
    remote_track = loop.create_future()
    worker_id = None
    nonce = None
    room_name = None
    token = None
    status = "preview_start_failed"
    outcome = {"opened": False, "room_started": False, "joined": False, "hangup_confirmed": False}

    def valid_agent(participant):
        return participant is not None and participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT

    def subscribed(track, publication, participant):
        nonlocal worker_id
        if (
            valid_agent(participant) and track.kind == rtc.TrackKind.KIND_AUDIO
            and publication.name == "elysia-breeze" and not remote_track.done()
            and worker_id in (None, participant.identity)
        ):
            worker_id = participant.identity
            remote_track.set_result(track)

    def packet(event):
        if (
            worker_id is None or event.topic != TOPIC or not valid_agent(event.participant)
            or event.participant.identity != worker_id or len(event.data) > 16_384
        ):
            return
        try:
            obj = json.loads(event.data)
            if isinstance(obj, dict):
                observed.packet(obj, loop.time())
        except (ValueError, RecursionError):
            pass

    async def listen():
        assert stream is not None
        async for event in stream:
            if any(abs(sample) >= 100 for sample in event.frame.data):
                observed.audio(loop.time())

    room.on("track_subscribed", subscribed)
    room.on("data_received", packet)
    async with aiohttp.ClientSession(
        cookie_jar=aiohttp.CookieJar(unsafe=True), trust_env=False,
        timeout=aiohttp.ClientTimeout(total=6),
    ) as http:
        try:
            await login(http, path)
            http_status, opened = await post(http, "open", {})
            if http_status != 200 or not isinstance(opened, dict) or opened.get("sessionId") != SESSION_ID:
                raise SmokeError("preview_open_http_" + str(http_status))
            outcome["opened"] = True
            if opened.get("inputMode") != expected_mode:
                raise SmokeError("preview_open_mode_mismatch")
            outcome["input_mode"] = expected_mode
            http_status, start = await post(http, "start", {"sessionId": SESSION_ID, "inputMode": expected_mode})
            if http_status != 200:
                raise SmokeError("preview_start_http_" + str(http_status))
            # Capture only validated stop fields even if another response field is malformed.
            if isinstance(start, dict) and isinstance(start.get("roomName"), str) and ROOM.fullmatch(start["roomName"]):
                value = start.get("callToken")
                if isinstance(value, str) and HEX.fullmatch(value):
                    room_name, nonce = start["roomName"], value
            room_name, identity, token, nonce = parse_start(start, expected_mode)
            del start
            outcome["room_started"] = True
            async with asyncio.timeout(20):
                await room.connect(MEDIA, token)
                token = None
                if room.name != room_name or room.local_participant.identity != identity:
                    raise SmokeError("rtc_identity_mismatch")
                outcome["joined"] = True
                outgoing = rtc.LocalAudioTrack.create_audio_track("synthetic-smoke-mic", source)
                await room.local_participant.publish_track(
                    outgoing, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )
                track = await remote_track
                stream = rtc.AudioStream.from_track(track=track, sample_rate=SAMPLE_RATE, num_channels=1, capacity=50)
                read_task = asyncio.create_task(listen())
            outcome["worker_ready"] = True

            async def first_turn():
                await publish_pcm(source, prompts[0])
                await observed.wait(lambda: observed.terminal(1))

            status = "turn1_deadline" if multi else "turn_deadline"
            async with asyncio.timeout(limit):
                await first_turn()
                if not multi and observed.turns[1].done:
                    # Let the server journal consume the terminal event before hangup.
                    await asyncio.sleep(0.7)
            status = observed.completion(1)
            if multi and status == "match":
                second, third = observed.turns[2], observed.turns[3]
                status = "turn2_deadline"
                async with asyncio.timeout(limit):
                    await publish_pcm(source, prompts[1])
                    await observed.wait(lambda: second.frames >= 8 or observed.terminal(2))
                if observed.terminal(2):
                    status = second.failure or "turn2_completed_before_barge_in"
                elif not observed.voice_ok(2):
                    status = "turn2_transcript_evidence_missing_or_unexpected"
                else:
                    status = "turn3_deadline"
                    barge_started = loop.time()
                    async with asyncio.timeout(limit):
                        await publish_pcm(source, prompts[2])
                        await observed.wait(lambda: observed.terminal(3) or second.done or second.failure is not None)
                        if third.done:
                            await asyncio.sleep(0.7)
                    status = observed.completion(3) if observed.terminal(3) else (
                        second.failure or "turn2_completed_after_barge_in"
                    )
                    if status == "match" and (
                        second.interrupted is None or second.interrupted < barge_started
                        or second.done or second.stale_events
                    ):
                        status = "missing_interrupt_or_stale_output"
                    if status == "match" and (
                        observed.late_audio or third.speaking is None
                        or elapsed(observed.interrupt_residual or second.interrupted, third.speaking) < 250
                    ):
                        status = "interruption_quiet_gap_missing"
        except TimeoutError:
            if not outcome.get("worker_ready"):
                status = "rtc_or_worker_deadline"
        except SmokeError as error:
            status = str(error)
        except Exception:
            status = "smoke_transport_failed"
        finally:
            token = None
            if read_task is not None:
                read_task.cancel()
                await asyncio.gather(read_task, return_exceptions=True)
            if stream is not None:
                try:
                    async with asyncio.timeout(1.5):
                        await stream.aclose()
                except Exception:
                    pass
            try:
                async with asyncio.timeout(2):
                    await room.disconnect()
            except Exception:
                pass
            if room_name and nonce:
                try:
                    http_status, value = await post(http, "stop", {
                        "sessionId": SESSION_ID, "roomName": room_name, "callToken": nonce,
                    })
                    outcome["hangup_confirmed"] = (
                        http_status == 200 and value == {"ok": True}
                    ) or (http_status == 404 and value == {"error": "cascade_call_not_found"})
                    outcome["stop_http"] = http_status
                except Exception:
                    outcome["hangup_confirmed"] = False
            try:
                async with asyncio.timeout(1.5):
                    await source.aclose()
            except Exception:
                pass
    details = observed.report(1)
    if multi:
        second, third = observed.turns[2], observed.turns[3]
        details = {
            "turns": {number: observed.report(number) for number in observed.turns},
            "barge_to_interrupt_ms": elapsed(barge_started, second.interrupted),
            "post_interrupt_late_audio_frames": observed.late_audio,
            "interruption_quiet_gap_ms": elapsed(
                observed.interrupt_residual or second.interrupted, third.speaking,
            ),
        }
    return {**outcome, **details, "status": status, "real_microphone": False}


async def self_test() -> None:
    assert expected("Fourteen.") and expected("The answer is 14.") and not expected("114")
    assert expected_transcript("What is nine plus five?") and expected_transcript("9+5")
    assert expected_transcript("Please tell me what9 plus5 is in English.")
    assert expected_transcript("Please count out loud from1 to50 slowly.", 2)
    assert expected_transcript("Please add4 to your first answer.", 3)
    assert expected("Eighteen", 3) and not expected("Eight", 3)
    assert not expected_transcript("ninety plus five") and not expected_transcript("19 + 50")
    assert LOGIN.search(b"Open http://127.0.0.1:18795/?token=not-a-real-token\n")
    assert not LOGIN.search(b"http://127.0.0.1:3299/?token=not-a-real-token")
    room = "elysia-gemini-cascade-" + "0" * 32
    response = {
        "roomName": room, "serverUrl": MEDIA, "participantIdentity": "pilot-user-" + "0" * 24,
        "participantToken": "x" * 128, "callToken": "f" * 64, "inputMode": "local-asr",
    }
    assert parse_start(response, "local-asr")[0] == room
    try:
        parse_start(response, "direct-audio")
    except SmokeError as error:
        assert str(error) == "preview_start_mode_mismatch"
    else:
        raise AssertionError("input mode mismatch accepted")
    try:
        parse_start({"serverUrl": "ws://external.example", "inputMode": "local-asr"}, "local-asr")
    except SmokeError:
        pass
    else:
        raise AssertionError("external endpoint accepted")
    durations = []
    for prompt in (PROMPT, LONG_PROMPT, BARGE_PROMPT):
        pcm = await synthetic_prompt(prompt)
        assert max(map(abs, memoryview(pcm).cast("h"))) > 2_000
        detector = EnergyTurns()
        recognized = [body for frame in pcm_chunks(pcm) if (body := detector.feed(frame)[1]) is not None]
        assert len(recognized) == 1 and len(recognized[0]) / (INPUT_RATE * 2) >= 1.2
        durations.append(round(len(pcm) / 2 / INPUT_RATE * 1000))
    assert hasattr(rtc.ParticipantKind, "PARTICIPANT_KIND_AGENT")
    assert hasattr(rtc.RemoteTrackPublication, "name")

    observed = ObservedTurns("local-asr", True)
    observed.packet({"turn": 1, "type": "state", "state": "transcribing"}, 1.0)
    observed.packet({"turn": 1, "type": "user", "input": "voice", "text": "what9 plus5"}, 1.1)
    observed.packet({"turn": 1, "type": "state", "state": "thinking"}, 1.2)
    observed.packet({"turn": 1, "type": "delta", "text": "14"}, 2.0)
    observed.packet({"turn": 1, "type": "state", "state": "speaking"}, 2.1)
    for index in range(8):
        observed.audio(2.2 + index / 50)
    observed.packet({"turn": 1, "type": "done", "text": "14"}, 2.9)
    assert observed.completion(1) == "match" and observed.report(1)["asr_to_final_ms"] == 100
    observed.packet({"turn": 2, "type": "state", "state": "speaking"}, 3.0)
    observed.packet({"turn": 2, "type": "interrupted"}, 3.1)
    observed.audio(3.2)
    assert observed.late_audio == 0
    observed.audio(3.9)
    observed.packet({"turn": 2, "type": "delta", "text": "late"}, 4.0)
    assert observed.late_audio == 1 and observed.turns[2].stale_events == 1
    print(json.dumps({"self_test": "passed", "flite_pcm_ms": durations, "local_vad_turns": [1, 1, 1],
                      "event_and_stale_detection": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-log", type=Path, help="owner-only DSH preview log; never copied or printed")
    parser.add_argument("--expect-mode", choices=("local-asr", "direct-audio"),
                        help="required for a live probe; reject other modes before publishing any audio")
    parser.add_argument("--timeout", type=int, default=105, choices=range(20, 121), metavar="20..120")
    parser.add_argument("--multi-turn", action="store_true",
                        help="local ASR only: complete a reply, barge in during the next, complete the third")
    parser.add_argument("--self-test", action="store_true", help="offline checks; no DSH, RTC, Gemini, or Breeze")
    args = parser.parse_args()
    if args.self_test and args.preview_log is None and args.expect_mode is None and not args.multi_turn:
        asyncio.run(self_test())
    elif args.preview_log is not None and args.expect_mode is not None and not args.self_test:
        if args.multi_turn and args.expect_mode != "local-asr":
            parser.error("--multi-turn requires --expect-mode local-asr")
        try:
            evidence = asyncio.run(run(args.preview_log, args.timeout, args.expect_mode, multi=args.multi_turn))
        except Exception:
            evidence = {"status": "smoke_setup_failed"}
        print(json.dumps(evidence), flush=True)
        raise SystemExit(0 if evidence["status"] == "match" and evidence.get("hangup_confirmed") else 1)
    else:
        parser.error("choose --self-test or --preview-log with --expect-mode")
