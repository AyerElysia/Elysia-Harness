"""Private DSH-to-LiveKit broker and one-shot launcher for the Gemini voice pilot."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
from collections.abc import Callable
import datetime
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import sys
import time
import tomllib

import aiohttp
from aiohttp import web
from livekit import api

from gemini_cascade import (
    LOOPBACK_ENDPOINT,
    MAX_OUTPUT_CHARS,
    GeminiConfig,
    GeminiError,
    stream_reply,
)

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parents[1]
ROUTE_CONFIG = HERE.parents[2] / "config" / "models.toml"
SOUL_PATH = HARNESS / "homes" / "web" / "standing-prompts" / "SOUL.md"
LIVEKIT_URL = "ws://127.0.0.1:18780"
LIVEKIT_API_URL = "http://127.0.0.1:18780"
WORKER_HEALTH = "http://127.0.0.1:18792/"
EVENTS_URL = "http://127.0.0.1:18793/events"
ASR_URL = "http://127.0.0.1:18796/transcribe"
ASR_HEALTH = "http://127.0.0.1:18796/health"
HOST = "127.0.0.1"
PORT = 18794
AGENT = "elysia-gemini-cascade-pilot"
ROOM = re.compile(r"elysia-gemini-cascade-[a-f0-9]{32}\Z")
PILOT_CONFIG = re.compile(r"/tmp/elyharn-livekit-pilot\.[A-Za-z0-9]{8}/livekit-private\.json\Z")
RUNTIME = re.compile(r"/tmp/elyharn-gemini-cascade\.[A-Za-z0-9]{8}\Z")
KEY = re.compile(r"[A-Za-z0-9_.~-]{24,512}\Z")
GEMINI_MODEL = "gemini-3.8-flash"
JOIN_SECONDS = 30
ROOM_TIMEOUT = 5
TEXT_TIMEOUT = 40
MAX_MESSAGE_BYTES = 96 * 1024
MAX_HTTP_BYTES = 600 * 1024
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def read_private(path: Path, limit: int) -> bytes:
    """Read a bounded owned mode-0600 file without following a final symlink."""
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("pilot_private_file_invalid")
        data = file.read(limit + 1)
    if not data or len(data) > limit:
        raise RuntimeError("pilot_private_file_size_invalid")
    return data


def require_private_dir(path: Path, pattern: re.Pattern[str]) -> None:
    """Refuse arbitrary runtime locations and symlink indirection."""
    info = path.lstat()
    if not pattern.fullmatch(str(path)) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("pilot_runtime_directory_invalid")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("pilot_runtime_directory_invalid")


def read_livekit(path: Path) -> tuple[str, str]:
    """Take an in-memory copy of the existing pilot's private LiveKit API key."""
    if not PILOT_CONFIG.fullmatch(str(path)):
        raise RuntimeError("pilot_livekit_config_invalid")
    require_private_dir(path.parent, re.compile(r"/tmp/elyharn-livekit-pilot\.[A-Za-z0-9]{8}\Z"))
    data = json.loads(read_private(path, 16 * 1024))
    keys = data.get("keys")
    if not isinstance(keys, dict) or len(keys) != 1:
        raise RuntimeError("pilot_livekit_config_invalid")
    key, secret = next(iter(keys.items()))
    if (
        not isinstance(key, str) or not re.fullmatch(r"elysia_pilot_[a-f0-9]{16}", key)
        or not isinstance(secret, str) or not re.fullmatch(r"[a-f0-9]{64}", secret)
    ):
        raise RuntimeError("pilot_livekit_config_invalid")
    return key, secret


def read_a6(path: Path = ROUTE_CONFIG) -> GeminiConfig:
    """Resolve the exact audio-capable Elysium model and existing local relay token."""
    data = tomllib.loads(read_private(path, 256 * 1024).decode("utf-8"))
    model = data["models"][GEMINI_MODEL]
    relay = data["providers"]["NexusAI"]
    if (
        model.get("provider") != "NexusAI" or model.get("id") != GEMINI_MODEL
        or model.get("audio") is not True or relay.get("client_type") != "openai"
        or relay.get("base_url") not in ("http://localhost:3000/v1", "http://127.0.0.1:3000/v1")
        or not isinstance(relay.get("api_key"), str)
    ):
        raise RuntimeError("pilot_a6_route_invalid")
    return GeminiConfig(LOOPBACK_ENDPOINT, GEMINI_MODEL, relay["api_key"])


def result(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, headers=HEADERS)


def failure(code: str, status: int) -> web.Response:
    return result({"error": code}, status)


def valid_messages(body: object) -> list[dict] | None:
    if not isinstance(body, dict) or set(body) != {"messages"}:
        return None
    messages = body["messages"]
    if not isinstance(messages, list) or not 1 <= len(messages) <= 33:
        return None
    total = 0
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            return None
        role, content = message["role"], message["content"]
        if (
            not isinstance(role, str) or role not in {"system", "user", "assistant"}
            or (role == "system" and index != 0)
            or not isinstance(content, str) or not content.strip() or "\x00" in content
        ):
            return None
        try:
            total += len(content.encode("utf-8"))
        except UnicodeError:
            return None
        if total > MAX_MESSAGE_BYTES:
            return None
    return messages if messages[-1]["role"] == "user" else None


class Broker:
    """One room or text request at a time; only this instance's room is deletable."""

    def __init__(
        self,
        livekit: api.LiveKitAPI,
        api_key: str,
        api_secret: str,
        model: GeminiConfig,
        model_http: aiohttp.ClientSession,
        *, local_asr: bool = False,
    ) -> None:
        self.livekit, self.api_key, self.api_secret = livekit, api_key, api_secret
        self.model, self.model_http = model, model_http
        self.input_mode = "local-asr" if local_asr else "direct-audio"
        self.lock = asyncio.Lock()
        self.active: tuple[str, float] | None = None
        self.last_stopped: str | None = None
        self.text_active = False

    async def _still_busy(self) -> bool:
        if self.active is None:
            return False
        room, issued = self.active
        if time.monotonic() < issued + JOIN_SECONDS:
            return True
        async with asyncio.timeout(ROOM_TIMEOUT):
            listing = await self.livekit.room.list_rooms(api.ListRoomsRequest(names=[room]))
        if listing.rooms:
            return True
        self.active = None
        self.last_stopped = room
        return False

    async def _delete_active(self) -> None:
        if self.active is None:
            return
        room, _ = self.active
        try:
            async with asyncio.timeout(ROOM_TIMEOUT):
                await self.livekit.room.delete_room(api.DeleteRoomRequest(room=room))
        except api.TwirpError as exc:
            if exc.code != api.TwirpErrorCode.NOT_FOUND:
                raise
        self.active = None
        self.last_stopped = room

    async def start(self, *, turn_mode: str | None = None) -> web.Response:
        if turn_mode is not None and (turn_mode != "main-session" or self.input_mode != "local-asr"):
            return failure("pilot_input_mode_mismatch", 409)
        async with self.lock:
            try:
                if self.text_active or await self._still_busy():
                    return failure("pilot_busy", 409)
            except (api.TwirpError, aiohttp.ClientError, TimeoutError):
                return failure("pilot_room_unavailable", 503)
            room = "elysia-gemini-cascade-" + secrets.token_hex(16)
            identity = "pilot-user-" + secrets.token_hex(12)
            metadata = {"participantIdentity": identity}
            if turn_mode is not None:
                metadata["turnMode"] = turn_mode
            dispatch = api.RoomAgentDispatch(
                agent_name=AGENT,
                metadata=json.dumps(metadata, separators=(",", ":")),
            )
            self.active = room, time.monotonic()
            try:
                async with asyncio.timeout(ROOM_TIMEOUT):
                    await self.livekit.room.create_room(api.CreateRoomRequest(
                        name=room, empty_timeout=JOIN_SECONDS, departure_timeout=5, max_participants=2,
                        agents=[dispatch], replay_enabled=False,
                    ))
            except (api.TwirpError, aiohttp.ClientError, TimeoutError):
                # The server may have created the room before the response was lost.
                with contextlib.suppress(api.TwirpError, aiohttp.ClientError, TimeoutError):
                    await self._delete_active()
                return failure("pilot_room_unavailable", 503)
            self.active = room, time.monotonic()
            token = (
                api.AccessToken(self.api_key, self.api_secret)
                .with_identity(identity)
                .with_ttl(datetime.timedelta(seconds=JOIN_SECONDS))
                .with_grants(api.VideoGrants(
                    room_join=True, room=room, can_subscribe=True, can_publish=True,
                    can_publish_data=turn_mode is None, can_publish_sources=["microphone"],
                ))
                # Dispatch belongs to the server-created room, not this replayable token.
                .to_jwt()
            )
        return result({
            "roomName": room, "serverUrl": LIVEKIT_URL, "participantToken": token,
            "participantIdentity": identity, "inputMode": self.input_mode,
            **({"turnMode": turn_mode} if turn_mode is not None else {}),
        })

    async def stop(self, room: str) -> web.Response:
        async with self.lock:
            if room == self.last_stopped:
                return result({"ok": True})
            if self.active is None or room != self.active[0]:
                return failure("pilot_room_not_owned", 404)
            try:
                await self._delete_active()
            except (api.TwirpError, aiohttp.ClientError, TimeoutError):
                return failure("pilot_room_unavailable", 503)
        return result({"ok": True})

    async def text(self, messages: list[dict]) -> web.Response:
        async with self.lock:
            try:
                if self.text_active or await self._still_busy():
                    return failure("pilot_busy", 409)
            except (api.TwirpError, aiohttp.ClientError, TimeoutError):
                return failure("pilot_room_unavailable", 503)
            self.text_active = True
        try:
            local_asr = self.input_mode == "local-asr"
            async with asyncio.timeout(76 if local_asr else TEXT_TIMEOUT):
                request = (stream_reply(self.model, self.model_http, messages, text_only=True, read_timeout=65)
                           if local_asr else stream_reply(self.model, self.model_http, messages))
                async with contextlib.aclosing(request) as stream:
                    text = "".join([part async for part in stream])
            if not text.strip() or len(text) >= MAX_OUTPUT_CHARS:
                return failure("pilot_text_incomplete", 502)
            return result({"text": text})
        except TimeoutError:
            return failure("pilot_text_timeout", 504)
        except GeminiError:
            return failure("pilot_text_unavailable", 502)
        finally:
            self.text_active = False

    async def aclose(self) -> None:
        async with self.lock:
            await self._delete_active()


def make_app(broker: Broker, bridge_key: str, ready: Callable[[], bool]) -> web.Application:
    """Expose an authenticated loopback service, with no browser access or CORS."""
    expected = ("Bearer " + bridge_key).encode("ascii")

    @web.middleware
    async def private(request: web.Request, handler):
        if request.host != f"{HOST}:{PORT}" or "Origin" in request.headers:
            return failure("pilot_forbidden", 403)
        if request.path != "/health":
            auth = request.headers.getall("Authorization", [])
            if len(auth) != 1 or not hmac.compare_digest(auth[0].encode("utf-8", errors="replace"), expected):
                return failure("pilot_forbidden", 403)
            if not ready() and request.path != "/stop":
                return failure("pilot_worker_unavailable", 503)
        return await handler(request)

    async def health(_request: web.Request) -> web.Response:
        ok = ready()
        return result({"ready": ok, "mode": "gemini-cascade-pilot"}, 200 if ok else 503)

    async def post(request: web.Request) -> web.Response:
        if request.content_type != "application/json":
            return failure("pilot_request_invalid", 400)
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            return failure("pilot_request_invalid", 400)
        except web.HTTPRequestEntityTooLarge:
            return failure("pilot_request_too_large", 413)
        if request.path == "/start":
            turn_mode = None
            if body == {"inputMode": "local-asr", "turnMode": "main-session"} and broker.input_mode == "local-asr":
                turn_mode = "main-session"
            elif body != {"inputMode": broker.input_mode} and not (body == {} and broker.input_mode == "direct-audio"):
                return failure("pilot_input_mode_mismatch", 409)
            if broker.input_mode == "local-asr":
                try:
                    async with broker.model_http.get(ASR_HEALTH, allow_redirects=False,
                                                     timeout=aiohttp.ClientTimeout(total=2)) as status:
                        if status.status != 200:
                            return failure("pilot_asr_unavailable", 503)
                except (aiohttp.ClientError, TimeoutError):
                    return failure("pilot_asr_unavailable", 503)
            return await broker.start(turn_mode=turn_mode)
        if request.path == "/stop":
            if (
                not isinstance(body, dict) or set(body) != {"roomName"}
                or not isinstance(body["roomName"], str) or not ROOM.fullmatch(body["roomName"])
            ):
                return failure("pilot_request_invalid", 400)
            return await broker.stop(body["roomName"])
        messages = valid_messages(body)
        if messages is None:
            return failure("pilot_request_invalid", 400)
        return await broker.text(messages)

    app = web.Application(client_max_size=MAX_HTTP_BYTES, middlewares=[private])
    app.add_routes([web.get("/health", health), *(web.post(path, post) for path in ("/start", "/stop", "/text"))])
    return app


async def wait_ready(
    http: aiohttp.ClientSession,
    url: str,
    timeout: float,
    worker: asyncio.subprocess.Process | None = None,
) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if worker is not None and worker.returncode is not None:
            raise RuntimeError("pilot_worker_exited")
        try:
            async with http.get(url, timeout=aiohttp.ClientTimeout(total=1), allow_redirects=False) as response:
                if response.status == 200:
                    return
        except (aiohttp.ClientError, TimeoutError):
            pass
        await asyncio.sleep(0.25)
    raise RuntimeError("pilot_worker_not_ready" if worker else "pilot_livekit_not_ready")


def require_free_ports() -> None:
    for port in (18792, PORT):
        try:
            with socket.socket() as listener:
                listener.bind((HOST, port))
        except OSError:
            raise RuntimeError(f"pilot_port_{port}_in_use") from None


async def run(config_path: Path, bridge_path: Path, runtime: Path, *, local_asr: bool = False) -> None:
    """Own only the named worker subprocess, private broker port, and issued rooms."""
    require_private_dir(runtime, RUNTIME)
    require_free_ports()
    key, secret = read_livekit(config_path)
    bridge_key = read_private(bridge_path, 520).decode("ascii").strip()
    if not KEY.fullmatch(bridge_key):
        raise RuntimeError("pilot_bridge_credential_invalid")
    model = read_a6()
    if not SOUL_PATH.is_file():
        raise RuntimeError("pilot_soul_unavailable")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        loop.add_signal_handler(sig, stop.set)
    async with aiohttp.ClientSession(trust_env=False) as http:
        await wait_ready(http, LIVEKIT_API_URL + "/", 5)
        if local_asr:
            try:
                await wait_ready(http, ASR_HEALTH, 5)
            except RuntimeError:
                raise RuntimeError("pilot_asr_unavailable") from None
        worker_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(runtime),
            "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1", "OTEL_SDK_DISABLED": "true",
            "LIVEKIT_URL": LIVEKIT_URL, "LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret,
            "GEMINI_CASCADE_COMPLETIONS_URL": model.url,
            "GEMINI_CASCADE_MODEL": model.model, "GEMINI_CASCADE_API_KEY": model.key,
            "GEMINI_CASCADE_EVENTS_URL": EVENTS_URL, "GEMINI_CASCADE_EVENTS_KEY": bridge_key,
            "ELYSIA_VOICE_PILOT_SOUL_PATH": str(SOUL_PATH),
        }
        if local_asr:
            worker_env.update(GEMINI_CASCADE_ASR_URL=ASR_URL, GEMINI_CASCADE_ASR_KEY=bridge_key)
        log_path = runtime / "worker.log"
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as log:
            worker = await asyncio.create_subprocess_exec(
                sys.executable, "-B", str(HERE / "gemini_worker.py"), "start",
                cwd=HERE, env=worker_env, stdin=asyncio.subprocess.DEVNULL, stdout=log, stderr=log,
            )
        worker_env.clear()
        try:
            await wait_ready(http, WORKER_HEALTH, 25, worker)
            async with api.LiveKitAPI(url=LIVEKIT_API_URL, api_key=key, api_secret=secret) as livekit:
                broker = Broker(livekit, key, secret, model, http, local_asr=local_asr)
                runner = web.AppRunner(
                    make_app(broker, bridge_key, lambda: worker.returncode is None and not stop.is_set()),
                    access_log=None, shutdown_timeout=5, handler_cancellation=True,
                )
                try:
                    await runner.setup()
                    await web.TCPSite(runner, HOST, PORT).start()
                    print(f"Gemini voice pilot broker ready on {HOST}:{PORT} (no call started)", flush=True)
                    while not stop.is_set() and worker.returncode is None:
                        with contextlib.suppress(TimeoutError):
                            await asyncio.wait_for(stop.wait(), 0.5)
                    if worker.returncode is not None and not stop.is_set():
                        raise RuntimeError("pilot_worker_exited")
                finally:
                    try:
                        await runner.cleanup()
                    finally:
                        try:
                            await broker.aclose()
                        except (api.TwirpError, aiohttp.ClientError, TimeoutError):
                            print("pilot_room_cleanup_unconfirmed", file=sys.stderr, flush=True)
        finally:
            if worker.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    worker.terminate()
                try:
                    await asyncio.wait_for(worker.wait(), 15)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        worker.kill()
                    await asyncio.wait_for(worker.wait(), 4)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--bridge-key-file", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--local-asr", action="store_true", help="Use the private local recognizer; never forward microphone audio")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.config, args.bridge_key_file, args.runtime, local_asr=args.local_asr))
    except (Exception, KeyboardInterrupt) as exc:
        code = str(exc) if type(exc) is RuntimeError else ""
        print(code if re.fullmatch(r"pilot_[a-z0-9_]+", code) else "pilot_broker_start_failed", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
