"""Isolated RTC/cascade smoke: fake model, real Breeze and LiveKit, no dispatch or mic."""
from __future__ import annotations

import argparse
import array
import asyncio
import datetime
import json
import math
import os
from pathlib import Path
import re
import secrets
from unittest.mock import patch

import aiohttp
from livekit import api, rtc

from breeze_tts import SAMPLE_RATE, BreezeSettings
from gemini_cascade import FRAME_MS, INPUT_RATE
from gemini_worker import Conversation, Events
from smoke_rtc import URL

CALLER = "smoke-caller"
WORKER = "smoke-worker"


class ObservedEvents(Events):
    def __init__(self, room, name, http):
        super().__init__(room, name, CALLER, http, None, asyncio.Event())
        self.facts = []

    def send(self, kind, turn, **fields):
        self.facts.append((kind, turn))
        super().send(kind, turn, **fields)


class ObservedSource:
    def __init__(self, source):
        self.source = source
        self.clears = 0

    def clear_queue(self):
        self.clears += 1
        self.source.clear_queue()

    async def capture_frame(self, frame):
        await self.source.capture_frame(frame)

    async def wait_for_playout(self):
        await self.source.wait_for_playout()


def keys_from(config: Path):
    if not re.fullmatch(r"/tmp/elyharn-livekit-pilot\.[A-Za-z0-9]{8}/livekit-private\.json", str(config)):
        raise ValueError("private_pilot_config_required")
    fd = os.open(config, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        st = os.fstat(handle.fileno())
        if st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_size > 65536:
            raise ValueError("private_pilot_config_required")
        keys = json.load(handle)["keys"]
        key, secret = next(iter(keys.items()))
        return key, secret


async def wait_until(predicate, code: str, limit: float = 20) -> None:
    try:
        async with asyncio.timeout(limit):
            while not predicate():
                await asyncio.sleep(0.02)
    except TimeoutError:
        raise RuntimeError(code) from None


async def run(config: Path) -> None:
    key, secret = keys_from(config)
    name = "smoke-cascade-" + secrets.token_hex(12)
    caller, worker = rtc.Room(), rtc.Room()
    up = rtc.AudioSource(INPUT_RATE, 1, queue_size_ms=80)
    down = rtc.AudioSource(SAMPLE_RATE, 1, queue_size_ms=80)
    observed_source = ObservedSource(down)
    streams = []
    tasks = []
    call = None
    speaking_turn = None
    nonzero_by_turn: dict[int, int] = {}
    received_packets = []
    second_stream_cancelled = asyncio.Event()
    pending_model = asyncio.Event()
    models = 0

    async def fake_model(_config, _http, messages):
        nonlocal models
        models += 1
        voice = isinstance(messages[-1]["content"], list)
        if models == 1 and not voice:
            yield "第一轮测试。"
        elif models == 2 and not voice:
            try:
                yield "这是会被打断的一轮测试。"
                await pending_model.wait()
                yield "不应该播放的后续。"
            finally:
                second_stream_cancelled.set()
        elif models == 3 and voice and messages[-1]["content"][0]["type"] == "input_audio":
            yield "插话后继续测试。"
        else:
            raise RuntimeError("unexpected_fake_model_order")

    async def connect(room, identity):
        token = (
            api.AccessToken(key, secret).with_identity(identity)
            .with_ttl(datetime.timedelta(seconds=30))
            .with_grants(api.VideoGrants(room_join=True, room=name)).to_jwt()
        )
        await room.connect(URL, token)

    def on_packet(packet):
        nonlocal speaking_turn
        if packet.topic != "elysia.cascade.events.v1" or not packet.participant or packet.participant.identity != WORKER:
            return
        data = json.loads(packet.data)
        kind, turn = data["type"], data["turn"]
        received_packets.append((kind, turn))
        if kind == "state" and data["state"] == "speaking":
            speaking_turn = turn
        elif kind in {"interrupted", "done", "error"} and speaking_turn == turn:
            speaking_turn = None

    async def listen_down(stream):
        async for event in stream:
            if speaking_turn is not None and any(abs(sample) > 90 for sample in event.frame.data):
                nonzero_by_turn[speaking_turn] = nonzero_by_turn.get(speaking_turn, 0) + 1

    async def listen_up(stream):
        async for event in stream:
            frame = event.frame
            if frame.sample_rate == INPUT_RATE and frame.num_channels == 1:
                call.handle_audio(bytes(frame.data.cast("B")))

    async def inject_voice():
        count = INPUT_RATE * FRAME_MS // 1_000
        for idx in range(53):
            pcm = array.array("h", (
                int(7200 * math.sin(2 * math.pi * 321 * (idx * count + j) / INPUT_RATE)) if idx < 24 else 0
                for j in range(count)
            )).tobytes()
            await up.capture_frame(rtc.AudioFrame(pcm, INPUT_RATE, 1, count))
        await up.wait_for_playout()

    try:
        caller.on("data_received", on_packet)
        async with asyncio.timeout(78), aiohttp.ClientSession(trust_env=False) as local:
            await asyncio.gather(connect(caller, CALLER), connect(worker, WORKER))
            await wait_until(lambda: CALLER in worker.remote_participants and WORKER in caller.remote_participants,
                             "rtc_participants_missing", 5)
            # Subscribe by participant before it publishes, as when a real browser opens its mic.
            for room, peer, rate in ((caller, WORKER, SAMPLE_RATE), (worker, CALLER, INPUT_RATE)):
                streams.append(rtc.AudioStream.from_participant(
                    participant=room.remote_participants[peer],
                    track_source=rtc.TrackSource.SOURCE_MICROPHONE,
                    sample_rate=rate, num_channels=1, capacity=50, frame_size_ms=FRAME_MS,
                ))
            for room, source, track_name in ((caller, up, "smoke-mic"), (worker, down, "elysia-breeze")):
                await room.local_participant.publish_track(
                    rtc.LocalAudioTrack.create_audio_track(track_name, source),
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
                )
            events = ObservedEvents(worker, name, local)
            call = Conversation(
                observed_source, events, object(), object(), BreezeSettings.from_config(), local, "smoke",
            )
            tasks.extend((asyncio.create_task(events.publish()), asyncio.create_task(listen_up(streams[1])),
                          asyncio.create_task(listen_down(streams[0]))))
            with patch("gemini_worker.stream_reply", fake_model):
                call.handle_text("smoke-first")
                await wait_until(lambda: nonzero_by_turn.get(1, 0) >= 5, "first_breeze_audio_missing")
                await wait_until(lambda: ("done", 1) in received_packets, "first_done_missing")
                await asyncio.sleep(0.25)
                call.handle_text("smoke-barge")
                await wait_until(lambda: nonzero_by_turn.get(2, 0) >= 5,
                                 "second_breeze_audio_missing")
                await inject_voice()
                await wait_until(lambda: second_stream_cancelled.is_set() and ("interrupted", 2) in received_packets,
                                 "interrupt_missing", 4)
                await wait_until(lambda: ("done", 3) in received_packets, "third_done_missing")
                if ("done", 2) in events.facts or ("user", 3) not in events.facts or not observed_source.clears:
                    raise RuntimeError("stale_or_uninterrupted_response")
                if nonzero_by_turn.get(3, 0) < 5:
                    raise RuntimeError("post_interrupt_breeze_audio_missing")
                print(json.dumps({
                    "rtc": "two SDK participants", "actual_breeze": True, "actual_model": False,
                    "microphone": False, "completed_turns": 2, "interrupted_turns": 1,
                    "audio_source_clears": observed_source.clears, "received_nonzero_frames_by_turn": nonzero_by_turn,
                }), flush=True)
    finally:
        if call is not None:
            await call.aclose()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(stream.aclose() for stream in streams), return_exceptions=True)
        await asyncio.gather(caller.disconnect(), worker.disconnect(), up.aclose(), down.aclose(), return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        asyncio.run(run(args.config))
    except RuntimeError as error:
        value = str(error)
        print(value if re.fullmatch(r"[a-z0-9_]+", value) else "cascade_rtc_failed")
        raise SystemExit(1) from None
    except Exception:
        print("cascade_rtc_failed")
        raise SystemExit(1) from None
