"""Opt-in private RTC smoke. No microphone, model, recording, or DSH Agent."""
from __future__ import annotations

import argparse
import array
import asyncio
import datetime
import json
import math
from pathlib import Path
import re
import secrets

import aiohttp
from livekit import api, rtc

from breeze_tts import BreezeSettings, FRAME_BYTES, SAMPLE_RATE, iter_pcm

URL = "ws://127.0.0.1:18780"
SAMPLES = SAMPLE_RATE // 50


async def signal_frames(frequency: float):
    for block in range(25):
        yield array.array("h", (
            int(6_000 * math.sin(2 * math.pi * frequency * (block * SAMPLES + sample) / SAMPLE_RATE))
            for sample in range(SAMPLES)
        )).tobytes()


async def breeze_frames():
    settings = BreezeSettings.from_config()
    async with aiohttp.ClientSession(trust_env=False) as http:
        async for pcm in iter_pcm(settings, "你好，这是一段通话测试。", http, timeout_seconds=20):
            yield pcm


async def run(config: Path, use_breeze: bool) -> None:
    if not re.fullmatch(r"/tmp/elyharn-livekit-pilot\.[A-Za-z0-9]{8}/livekit-private\.json", str(config)):
        raise ValueError("pilot_config_required")
    key, secret = next(iter(json.loads(config.read_bytes())["keys"].items()))
    name = "smoke-" + secrets.token_hex(12)
    rooms = [rtc.Room(), rtc.Room()]
    remote_tracks = [asyncio.Future(), asyncio.Future()]
    sources = [rtc.AudioSource(SAMPLE_RATE, 1, queue_size_ms=100) for _ in rooms]
    streams = []

    def subscribe_at(index):
        def on_track(track, _publication, _participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO and not remote_tracks[index].done():
                remote_tracks[index].set_result(track)
        return on_track

    async def connect(index):
        token = (
            api.AccessToken(key, secret)
            .with_identity(f"smoke-{index}")
            .with_ttl(datetime.timedelta(seconds=30))
            .with_grants(api.VideoGrants(room_join=True, room=name))
            .to_jwt()
        )
        room = rooms[index]
        room.on("track_subscribed", subscribe_at(index))
        await room.connect(URL, token)
        track = rtc.LocalAudioTrack.create_audio_track("test", sources[index])
        await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )

    async def push(index, frames):
        async for pcm in frames:
            if not 0 < len(pcm) <= FRAME_BYTES or len(pcm) % 2:
                raise RuntimeError("unexpected_smoke_pcm")
            await sources[index].capture_frame(rtc.AudioFrame(pcm, SAMPLE_RATE, 1, len(pcm) // 2))
        await sources[index].wait_for_playout()

    async def receive(stream):
        count = 0
        async for event in stream:
            if any(abs(sample) > 50 for sample in event.frame.data):
                count += 1
            if count >= 5:
                return count
        raise RuntimeError("smoke_audio_missing")

    try:
        async with asyncio.timeout(35 if use_breeze else 15):
            await asyncio.gather(*(connect(index) for index in range(2)))
            for track in await asyncio.gather(*remote_tracks):
                streams.append(rtc.AudioStream.from_track(
                    track=track, sample_rate=SAMPLE_RATE, num_channels=1, capacity=50
                ))
            results = await asyncio.gather(
                receive(streams[0]), receive(streams[1]),
                push(0, breeze_frames() if use_breeze else signal_frames(440)),
                push(1, signal_frames(660)),
            )
            print(json.dumps({"media_both_directions": True, "received_nonzero_frames": results[:2],
                              "real_breeze": use_breeze, "openai": False, "microphone": False}))
    finally:
        await asyncio.gather(*(stream.aclose() for stream in streams), return_exceptions=True)
        await asyncio.gather(*(room.disconnect() for room in rooms), return_exceptions=True)
        await asyncio.gather(*(source.aclose() for source in sources), return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    parser.add_argument("--breeze", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args.config, args.breeze))
