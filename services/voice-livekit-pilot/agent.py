"""Explicitly dispatched LiveKit pilot; no DSH or durable conversation history."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

import aiohttp
from livekit import rtc
from livekit.agents import (
    APIConnectOptions,
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobExecutorType,
    JobRequest,
    cli,
    room_io,
)
from livekit.plugins import openai

from breeze_tts import BreezeSettings, BreezeTTS

AGENT_NAME = "elysia-voice-livekit-pilot"
ROOM_NAME = re.compile(r"elysia-voice-pilot-[a-f0-9]{32}\Z")
PARTICIPANT_ID = re.compile(r"[A-Za-z0-9_-]{1,96}\Z")
MODEL = "gpt-realtime-2.1-mini"
OPENAI_PROXY = "http://127.0.0.1:17878"
SOUL_ENV = "ELYSIA_VOICE_PILOT_SOUL_PATH"
MAX_SOUL_BYTES = 256_000
MAX_JOB_SECONDS = 600
JOIN_SECONDS = 20
START_SECONDS = 25
CLEANUP_SECONDS = 3


def dispatch_identity(room: str, metadata: str) -> str | None:
    """Only the pilot's explicitly dispatched one-participant room is accepted."""
    if not ROOM_NAME.fullmatch(room) or not metadata or len(metadata) > 256:
        return None
    try:
        payload = json.loads(metadata)
    except (ValueError, RecursionError):
        return None
    if not isinstance(payload, dict) or payload.keys() != {"participantIdentity"}:
        return None
    identity = payload["participantIdentity"]
    return identity if isinstance(identity, str) and PARTICIPANT_ID.fullmatch(identity) else None


def read_soul(path_text: str) -> str:
    """Read only the configured SOUL, preserving every byte of its UTF-8 text."""
    path = Path(path_text)
    if not path.is_absolute() or path.name != "SOUL.md" or not path.is_file():
        raise ValueError("pilot_soul_unavailable")
    with path.open("rb") as file:
        data = file.read(MAX_SOUL_BYTES + 1)
    if not data or len(data) > MAX_SOUL_BYTES:
        raise ValueError("pilot_soul_invalid")
    text = data.decode("utf-8", errors="strict")
    if not text.strip():
        raise ValueError("pilot_soul_invalid")
    return text


async def _request(req: JobRequest) -> None:
    if dispatch_identity(req.job.room.name, req.job.metadata) is None:
        await req.reject()
        return
    await req.accept(name="爱莉 · 语音试验")


def _pilot_load(worker: AgentServer) -> float:
    return float(len(worker.active_jobs))


server = AgentServer(
    job_executor_type=JobExecutorType.PROCESS,
    host="127.0.0.1",
    port=18791,
    num_idle_processes=0,
    load_fnc=_pilot_load,
    load_threshold=1.0,
    drain_timeout=10,
    shutdown_process_timeout=15,
    session_end_timeout=10,
    http_proxy=None,
    log_level="WARN",
)


async def _clean(close: Callable[[], Awaitable[None]]) -> bool:
    try:
        async with asyncio.timeout(CLEANUP_SECONDS):
            await close()
        return True
    except Exception:
        # An upstream exception may include payloads. Only the cleanup flag leaves.
        return False


@server.rtc_session(agent_name=AGENT_NAME, on_request=_request)
async def pilot(ctx: JobContext) -> None:
    # Each job has its own process. Suppress library payload/exception logging in
    # that process before reading the prompt or creating any media/provider I/O.
    # Only fixed lifecycle codes are printed below. No trace exporter is configured.
    logging.disable(logging.CRITICAL)
    identity = dispatch_identity(ctx.job.room.name, ctx.job.metadata)
    if identity is None:
        ctx.shutdown(reason="pilot_invalid_dispatch")
        return

    ended = asyncio.Event()
    reason = "pilot_closed"
    phase = "join"
    session: AgentSession | None = None
    breeze: BreezeTTS | None = None
    http_session: aiohttp.ClientSession | None = None

    def stop(next_reason: str) -> None:
        nonlocal reason
        if not ended.is_set():
            reason = next_reason
            ended.set()

    def participant_left(participant: rtc.RemoteParticipant) -> None:
        if participant.identity == identity:
            stop("pilot_participant_left")

    def room_left(*_args: object) -> None:
        stop("pilot_room_disconnected")

    ctx.room.on("participant_disconnected", participant_left)
    ctx.room.on("disconnected", room_left)
    try:
        async with asyncio.timeout(MAX_JOB_SECONDS):
            async with asyncio.timeout(JOIN_SECONDS):
                await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
                await ctx.wait_for_participant(
                    identity=identity,
                    kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
                )
            if ended.is_set() or identity not in ctx.room.remote_participants:
                return

            phase = "setup"
            async with asyncio.timeout(START_SECONDS):
                soul = await asyncio.to_thread(read_soul, os.environ.get(SOUL_ENV, ""))
                settings = await asyncio.to_thread(BreezeSettings.from_config)
                if ended.is_set() or identity not in ctx.room.remote_participants:
                    return
                api_key = os.environ.get("OPENAI_API_KEY", "")
                if not api_key.strip():
                    raise ValueError("pilot_openai_credential_missing")

                breeze = BreezeTTS(settings)
                # Do not set HTTP_PROXY globally: this one session owns only OpenAI traffic.
                http_session = aiohttp.ClientSession(proxy=OPENAI_PROXY, trust_env=False)
                realtime = openai.realtime.RealtimeModel(
                    model=MODEL,
                    modalities=["text"],
                    tool_choice="none",
                    api_key=api_key,
                    base_url="https://api.openai.com/v1",
                    http_session=http_session,
                    tracing=None,
                    input_audio_transcription=None,
                    max_session_duration=None,
                    conn_options=APIConnectOptions(max_retry=0, timeout=20.0),
                )
                del api_key
                session = AgentSession(
                    llm=realtime,
                    tts=breeze,
                    vad=None,
                    expressive=False,
                    tts_text_transforms=[],
                )
                session.on("close", lambda _event: stop("pilot_session_closed"))
                await session.start(
                    Agent(instructions=soul, tools=[]),
                    room=ctx.room,
                    room_options=room_io.RoomOptions(
                        participant_identity=identity,
                        participant_kinds=[rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD],
                        audio_input=room_io.AudioInputOptions(pre_connect_audio=False),
                        audio_output=True,
                        video_input=False,
                        text_input=False,
                        text_output=False,
                        close_on_disconnect=False,  # This owner handles every departure reason.
                    ),
                    session_host=False,
                    record=False,
                )
                del soul
            phase = "conversation"
            if not ended.is_set():
                print("pilot_agent_session_started", flush=True)
            await ended.wait()
    except TimeoutError:
        stop(f"pilot_{phase}_deadline")
    except asyncio.CancelledError:
        stop("pilot_job_cancelled")
        raise
    except Exception:
        stop(f"pilot_{phase}_failed")
    finally:
        ctx.room.off("participant_disconnected", participant_left)
        ctx.room.off("disconnected", room_left)
        clean = True
        if session is not None:
            clean = await _clean(session.aclose) and clean
        if http_session is not None:
            clean = await _clean(http_session.close) and clean
        if breeze is not None:
            clean = await _clean(breeze.aclose) and clean
        if not clean:
            print("pilot_cleanup_unconfirmed", flush=True)
        print(reason, flush=True)
        ctx.shutdown(reason=reason)


if __name__ == "__main__":
    cli.run_app(server)
