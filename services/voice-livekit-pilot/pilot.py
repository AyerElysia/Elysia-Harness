"""Foreground launcher and private token server for the isolated LiveKit voice trial."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import datetime
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import time

import aiohttp
from aiohttp import web
from livekit import api
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
HOME = ROOT / "homes" / "web"
WEB_HOST = "127.0.0.1:18790"
ORIGIN = f"http://{WEB_HOST}"
LIVEKIT_URL = "ws://127.0.0.1:18780"
AGENT_NAME = "elysia-voice-livekit-pilot"
ROOM_PREFIX = "elysia-voice-pilot-"
CONTAINER = "elyharn-voice-livekit-pilot"
IMAGE = "sha256:5796e112169dfdf228d085f43f5833593654785a62782b3daed5222911d4e685"
COOKIE = "elysia_livekit_pilot"
JOIN_SECONDS = 30


def write_private(path: Path, data: bytes) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(data)


def read_model_key() -> str:
    path = HOME / ".credentials.yaml"
    stat = path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise RuntimeError("credential_file_not_private")
    value = yaml.safe_load(path.read_bytes())["refs"]["OPENAI_REALTIME_API_KEY"]
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise RuntimeError("model_credential_unavailable")
    return value


def private_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
        "Content-Security-Policy": (
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:18780; "
            "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        ),
    }


def make_app(api_key: str, api_secret: str, livekit: api.LiveKitAPI) -> web.Application:
    nonce = secrets.token_urlsafe(32)
    lock = asyncio.Lock()
    previous: tuple[str, float] | None = None
    dist = (HERE / "frontend" / "dist").resolve()

    @web.middleware
    async def local_only(request: web.Request, handler):
        if request.host != WEB_HOST:
            raise web.HTTPForbidden()
        return await handler(request)

    async def index(request: web.Request) -> web.StreamResponse:
        response = web.FileResponse(dist / "index.html", headers=private_headers())
        response.set_cookie(COOKIE, nonce, httponly=True, samesite="Strict", path="/")
        return response

    async def static(request: web.Request) -> web.StreamResponse:
        path = (dist / "assets" / request.match_info["name"]).resolve()
        if not path.is_relative_to(dist / "assets") or not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers=private_headers())

    async def token(request: web.Request) -> web.StreamResponse:
        nonlocal previous
        if (
            request.headers.get("Origin") != ORIGIN
            or not hmac.compare_digest(request.cookies.get(COOKIE, ""), nonce)
        ):
            raise web.HTTPForbidden()
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest() from None
        if body != {}:
            raise web.HTTPBadRequest()
        async with lock:
            now = time.monotonic()
            if previous is not None:
                old_room, issued_at = previous
                if now < issued_at + JOIN_SECONDS:
                    return web.json_response({"error": "pilot_busy"}, status=409, headers=private_headers())
                try:
                    async with asyncio.timeout(3):
                        rooms = await livekit.room.list_rooms(api.ListRoomsRequest(names=[old_room]))
                except Exception:
                    return web.json_response({"error": "pilot_unavailable"}, status=503, headers=private_headers())
                if rooms.rooms:
                    return web.json_response({"error": "pilot_busy"}, status=409, headers=private_headers())
            room = ROOM_PREFIX + secrets.token_hex(16)
            participant = "pilot-user-" + secrets.token_hex(12)
            dispatch = api.RoomAgentDispatch(
                agent_name=AGENT_NAME,
                metadata=json.dumps({"participantIdentity": participant}, separators=(",", ":")),
            )
            config = api.RoomConfiguration(
                name=room, empty_timeout=20, departure_timeout=5, max_participants=2,
                agents=[dispatch],
            )
            jwt = (
                api.AccessToken(api_key, api_secret)
                .with_identity(participant)
                .with_name("通话测试")
                .with_ttl(datetime.timedelta(seconds=JOIN_SECONDS))
                .with_grants(api.VideoGrants(
                    room_join=True, room=room, can_subscribe=True, can_publish=True,
                    can_publish_data=False, can_publish_sources=["microphone"],
                ))
                .with_room_config(config)
                .to_jwt()
            )
            previous = room, now
        return web.json_response(
            {"serverUrl": LIVEKIT_URL, "roomName": room, "participantName": "通话测试", "participantToken": jwt},
            headers=private_headers(),
        )

    async def health(_request: web.Request) -> web.StreamResponse:
        return web.json_response({"ready": True, "mode": "isolated-pilot"}, headers=private_headers())

    app = web.Application(client_max_size=1024, middlewares=[local_only])
    app.add_routes([web.get("/", index), web.get("/assets/{name}", static),
                    web.get("/health", health), web.post("/api/token", token)])
    return app


def require_unused_ports() -> None:
    for port in (18780, 18781, 18790, 18791):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))


async def await_http(port: int, limit: float, proc: subprocess.Popen | None = None) -> None:
    end = time.monotonic() + limit
    async with aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=1)) as session:
        while time.monotonic() < end:
            if proc is not None and proc.poll() is not None:
                raise RuntimeError("pilot_worker_exited")
            try:
                async with session.get(f"http://127.0.0.1:{port}/") as response:
                    if response.status == 200:
                        return
            except (aiohttp.ClientError, TimeoutError):
                pass
            await asyncio.sleep(0.3)
    raise RuntimeError(f"pilot_readiness_timeout_{port}")


async def run(runtime: Path) -> None:
    if not (HERE / "frontend" / "dist" / "index.html").is_file():
        raise RuntimeError("build_frontend_first")
    if not (HERE / "agent.py").is_file():
        raise RuntimeError("agent_missing")
    stat = runtime.stat()
    if (
        not re.fullmatch(r"/tmp/elyharn-livekit-pilot\.[A-Za-z0-9]{8}", str(runtime))
        or runtime.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077
    ):
        raise RuntimeError("runtime_dir_not_private")
    require_unused_ports()
    key, secret = "elysia_pilot_" + secrets.token_hex(8), secrets.token_hex(32)
    config = runtime / "livekit-private.json"
    worker_log = runtime / "worker.log"
    worker: subprocess.Popen | None = None
    container: str | None = None
    runner: web.AppRunner | None = None
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        loop.add_signal_handler(sig, stop.set)
    model_key = read_model_key()
    soul = HOME / "standing-prompts" / "SOUL.md"
    if not soul.is_file():
        raise RuntimeError("standing_soul_not_found")
    write_private(config, json.dumps({
        "port": 18780,
        "bind_addresses": ["0.0.0.0"],
        "rtc": {
            "tcp_port": 18781, "force_tcp": True, "use_external_ip": False,
            # Docker forwards TCP to eth0. Do not also rewrite lo to this same ICE candidate.
            "node_ip": "127.0.0.1", "enable_loopback_candidate": False,
            "interfaces": {"includes": ["eth0"]},
        },
        "keys": {key: secret}, "logging": {"level": "warn"},
    }).encode())
    try:
        result = subprocess.run(
            ["docker", "run", "--detach", "--rm", "--pull=never", "--name", CONTAINER,
             "--label", "org.elyharn.role=voice-livekit-pilot", "--restart=no",
             "--publish", "127.0.0.1:18780:18780/tcp", "--publish", "127.0.0.1:18781:18781/tcp",
             # Keep the bind-mounted credentials at mode 0600 without granting DAC override.
             "--user", f"{os.getuid()}:{os.getgid()}",
             "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
             "--log-driver=local", "--log-opt=max-size=2m", "--log-opt=max-file=2",
             "--mount", f"type=bind,src={config},dst=/run/elyharn-livekit.json,readonly",
             IMAGE, "--config", "/run/elyharn-livekit.json"],
            check=True, timeout=20, capture_output=True, text=True,
        )
        if re.fullmatch(r"[a-f0-9]{64}", result.stdout.strip()):
            container = result.stdout.strip()
        else:
            raise RuntimeError("invalid_pilot_container_identity")
        await await_http(18780, 12)
        worker_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(runtime), "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "OTEL_SDK_DISABLED": "true",
            "LIVEKIT_URL": LIVEKIT_URL, "LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret,
            "OPENAI_API_KEY": model_key, "ELYSIA_VOICE_PILOT_SOUL_PATH": str(soul),
        }
        fd = os.open(worker_log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as log:
            worker = subprocess.Popen(
                [sys.executable, str(HERE / "agent.py"), "start"],
                cwd=HERE, env=worker_env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            )
        worker_env.clear()
        model_key = ""
        await await_http(18791, 30, worker)
        async with api.LiveKitAPI(url="http://127.0.0.1:18780", api_key=key, api_secret=secret) as lk:
            runner = web.AppRunner(make_app(key, secret, lk), access_log=None)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", 18790).start()
            print("LiveKit pilot ready at http://127.0.0.1:18790/ (no call has started)", flush=True)
            while not stop.is_set() and worker.poll() is None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=1)
            if worker.poll() is not None and not stop.is_set():
                raise RuntimeError("pilot_worker_exited")
    finally:
        if runner is not None:
            await runner.cleanup()
        if worker is not None and worker.poll() is None:
            worker.terminate()
            try:
                await asyncio.to_thread(worker.wait, 15)
            except subprocess.TimeoutExpired:
                print("pilot worker did not stop in 15s; PID", worker.pid, flush=True)
        if container is not None:
            with contextlib.suppress(subprocess.SubprocessError):
                await asyncio.to_thread(
                    subprocess.run, ["docker", "stop", "--time", "10", container],
                    timeout=15, check=True, capture_output=True,
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(args.runtime))
    except RuntimeError as exc:
        # Report only our fixed codes; never dump provider, auth, or HTTP exceptions.
        code = str(exc)
        print(code if re.fullmatch(r"[a-z0-9_]+", code) else "pilot_start_failed", file=sys.stderr)
        raise SystemExit(1) from None
    except (Exception, KeyboardInterrupt):
        print("pilot_start_failed", file=sys.stderr)
        raise SystemExit(1) from None
