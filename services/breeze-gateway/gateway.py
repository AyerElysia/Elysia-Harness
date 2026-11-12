"""Bounded HTTP-only adapter for the unmodified official Breeze streaming API.

This module never imports a model runtime or handles token generation. One process
with one Uvicorn worker owns the FIFO. Bind it to loopback only.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
from pathlib import Path
import time
from typing import Any
from urllib.parse import urlsplit
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import httpx

LOGGER = logging.getLogger("breeze.gateway")


@dataclass(frozen=True)
class Settings:
    backend_url: str = "http://127.0.0.1:7863"
    queue_capacity: int = 8
    queue_timeout_ms: int = 30_000
    job_timeout_ms: int = 300_000
    cancel_grace_ms: int = 10_000
    max_body_bytes: int = 16 * 1024 * 1024
    drain_file: Path | None = None

    def __post_init__(self) -> None:
        url = urlsplit(self.backend_url)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"}
                or url.username or url.password or url.query or url.fragment
                or url.path not in {"", "/"}):
            raise ValueError("backend_url must be a credential-free loopback HTTP origin")
        for field in ("queue_capacity", "queue_timeout_ms", "job_timeout_ms",
                      "cancel_grace_ms", "max_body_bytes"):
            if getattr(self, field) <= 0:
                raise ValueError(f"{field} must be positive")


class ProxyError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


class ClientGone(Exception):
    pass


@dataclass
class Ticket:
    id: str
    state: str = "queued"


class Scheduler:
    """Own one active HTTP stream and bounded waiting requests, not the GPU."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.condition = asyncio.Condition()
        self.waiting: deque[Ticket] = deque()
        self.active: Ticket | None = None
        self.fault: str | None = None
        self.last_error: str | None = None
        self.completed = 0

    @property
    def draining(self) -> bool:
        return self.settings.drain_file is not None and self.settings.drain_file.exists()

    @asynccontextmanager
    async def slot(self, ticket: Ticket, deadline: float):
        async with self.condition:
            if self.fault:
                raise ProxyError(503, self.fault)
            if self.draining:
                raise ProxyError(503, "gateway_draining")
            if len(self.waiting) >= self.settings.queue_capacity:
                raise ProxyError(503, "gateway_queue_full")
            self.waiting.append(ticket)
            queue_deadline = min(deadline, time.monotonic() + self.settings.queue_timeout_ms / 1000)
            try:
                while self.active is not None or self.waiting[0] is not ticket:
                    if self.fault:
                        raise ProxyError(503, self.fault)
                    remaining = queue_deadline - time.monotonic()
                    if remaining <= 0:
                        raise ProxyError(504, "gateway_queue_timeout")
                    try:
                        await asyncio.wait_for(self.condition.wait(), remaining)
                    except TimeoutError as exc:
                        raise ProxyError(504, "gateway_queue_timeout") from exc
                if self.fault:
                    raise ProxyError(503, self.fault)
                self.waiting.popleft()
                self.active = ticket
                ticket.state = "connecting"
            except BaseException:
                if ticket in self.waiting:
                    self.waiting.remove(ticket)
                self.condition.notify_all()
                raise
        try:
            yield
        finally:
            async with self.condition:
                if self.active is ticket:
                    self.active = None
                self.condition.notify_all()

    async def quarantine(self, code: str) -> None:
        async with self.condition:
            self.fault = code
            self.last_error = code
            self.condition.notify_all()

    def snapshot(self) -> dict[str, Any]:
        return {
            "busy": self.active is not None,
            "queued": len(self.waiting),
            "queue_capacity": self.settings.queue_capacity,
            "queue_timeout_ms": self.settings.queue_timeout_ms,
            "job_timeout_ms": self.settings.job_timeout_ms,
            "cancel_grace_ms": self.settings.cancel_grace_ms,
            "draining": self.draining,
            "drained": self.active is None and not self.waiting,
            "active": {"id": self.active.id, "state": self.active.state} if self.active else None,
            "error_code": self.fault or self.last_error,
            "completed": self.completed,
        }


class SpeechProxy(Response):
    """Own receive, streaming, cancellation and cleanup for exactly one request."""

    def __init__(self, request: Request, client: httpx.AsyncClient,
                 scheduler: Scheduler, settings: Settings) -> None:
        super().__init__(content=b"")
        self.request = request
        self.client = client
        self.scheduler = scheduler
        self.settings = settings
        self.started = False
        self.upstream: httpx.Response | None = None
        self.ticket = Ticket(uuid.uuid4().hex)

    async def __call__(self, scope, receive, send) -> None:
        deadline = time.monotonic() + self.settings.job_timeout_ms / 1000
        try:
            requested = self.request.headers.get("x-breeze-timeout-ms")
            if requested is not None:
                try:
                    budget_ms = int(requested)
                except ValueError as exc:
                    raise ProxyError(400, "invalid_timeout") from exc
                if budget_ms <= 0:
                    raise ProxyError(400, "invalid_timeout")
                deadline = min(deadline, time.monotonic() + budget_ms / 1000)
            media_type = self.request.headers.get("content-type", "")
            if not media_type.lower().startswith(
                    ("multipart/form-data;", "application/x-www-form-urlencoded")):
                raise ProxyError(415, "expected_form_data")
            payload = bytearray()
            async with asyncio.timeout_at(deadline):
                while True:
                    event = await receive()
                    if event["type"] == "http.disconnect":
                        raise ClientGone
                    if event["type"] != "http.request":
                        continue
                    payload.extend(event.get("body", b""))
                    if len(payload) > self.settings.max_body_bytes:
                        raise ProxyError(413, "request_body_too_large")
                    if not event.get("more_body", False):
                        break
            # Only this task consumes receive after the upload is complete.
            watcher = asyncio.create_task(self._watch_disconnect(receive), name="breeze-client-disconnect")
            serving = asyncio.create_task(
                self._serve(bytes(payload), media_type, deadline, send), name="breeze-http-proxy"
            )
            try:
                done, _ = await asyncio.wait({watcher, serving}, return_when=asyncio.FIRST_COMPLETED)
                if serving in done:
                    await serving
                else:
                    serving.cancel()
                    await self._join_cancelled(serving)
            finally:
                watcher.cancel()
                if not serving.done():
                    serving.cancel()
                await self._join_cancelled(watcher)
                await self._join_cancelled(serving)
        except ClientGone:
            return
        except ProxyError as exc:
            self.scheduler.last_error = exc.code
            if self.started:
                raise RuntimeError("breeze_audio_stream_incomplete") from None
            await JSONResponse({"detail": exc.code}, status_code=exc.status)(scope, receive, send)
        except TimeoutError:
            self.scheduler.last_error = "gateway_job_timeout"
            if self.started:
                raise RuntimeError("breeze_audio_stream_incomplete") from None
            await JSONResponse({"detail": "gateway_job_timeout"}, status_code=504)(scope, receive, send)

    @staticmethod
    async def _join_cancelled(task: asyncio.Task) -> None:
        try:
            await task
        except asyncio.CancelledError:
            pass

    @staticmethod
    async def _watch_disconnect(receive) -> None:
        while (await receive())["type"] != "http.disconnect":
            pass

    async def _close_upstream(self) -> None:
        if self.upstream is None:
            return
        self.ticket.state = "cleaning"
        try:
            await asyncio.wait_for(
                self.upstream.aclose(), self.settings.cancel_grace_ms / 1000
            )
        except Exception:
            await self.scheduler.quarantine("backend_cleanup_unconfirmed")
            LOGGER.error("backend_cleanup_unconfirmed")
        finally:
            self.upstream = None

    async def _open_upstream(self, payload: bytes, content_type: str,
                             deadline: float) -> httpx.Response:
        # A 409 explicitly means this request did not acquire the official slot.
        # It is the only condition we retry, bounded by cleanup grace and deadline.
        busy_deadline = min(deadline, time.monotonic() + self.settings.cancel_grace_ms / 1000)
        while True:
            request = self.client.build_request(
                "POST", "/v1/audio/speech", content=payload,
                headers={"Content-Type": content_type},
            )
            self.upstream = await self.client.send(request, stream=True)
            if self.upstream.status_code != 409:
                return self.upstream
            await self._close_upstream()
            if self.scheduler.fault:
                raise ProxyError(503, self.scheduler.fault)
            if time.monotonic() >= busy_deadline:
                await self.scheduler.quarantine("backend_busy_after_grace")
                raise ProxyError(503, "backend_busy_after_grace")
            self.ticket.state = "waiting_backend_cleanup"
            await asyncio.sleep(min(0.1, max(0, busy_deadline - time.monotonic())))

    async def _serve(self, payload: bytes, content_type: str, deadline: float, send) -> None:
        try:
            async with asyncio.timeout_at(deadline):
                async with self.scheduler.slot(self.ticket, deadline):
                    try:
                        response = await self._open_upstream(payload, content_type, deadline)
                        if response.status_code != 200:
                            raise ProxyError(response.status_code, "backend_request_failed")
                        sample_rate = response.headers.get("x-sample-rate", "")
                        if (response.headers.get("content-type", "").split(";")[0] != "audio/pcm"
                                or response.headers.get("x-sample-format") != "s16le"
                                or not sample_rate.isdigit() or int(sample_rate) <= 0):
                            raise ProxyError(502, "backend_audio_protocol_error")
                        chunks = response.aiter_raw()
                        first = await anext(chunks, b"")
                        if not first:
                            raise ProxyError(502, "backend_empty_audio")
                        await send({
                            "type": "http.response.start", "status": 200,
                            "headers": [
                                (b"content-type", b"audio/pcm"),
                                (b"x-sample-rate", sample_rate.encode("ascii")),
                                (b"x-sample-format", b"s16le"),
                                (b"cache-control", b"no-store"),
                                (b"x-breeze-request-id", self.ticket.id.encode("ascii")),
                            ],
                        })
                        self.started = True
                        self.ticket.state = "streaming"
                        total = len(first)
                        await send({"type": "http.response.body", "body": first, "more_body": True})
                        async for chunk in chunks:
                            total += len(chunk)
                            await send({"type": "http.response.body", "body": chunk, "more_body": True})
                        if total % 2:
                            raise ProxyError(502, "backend_incomplete_pcm_sample")
                        await send({"type": "http.response.body", "body": b"", "more_body": False})
                        self.scheduler.completed += 1
                    finally:
                        # Cancellation cannot skip ownership cleanup. HTTP close
                        # does not claim immediate remote GPU completion: a later
                        # 409 remains bounded under the next global slot owner.
                        cleanup = asyncio.create_task(self._close_upstream(), name="breeze-upstream-cleanup")
                        try:
                            await asyncio.shield(cleanup)
                        except asyncio.CancelledError:
                            await cleanup
                            raise
        except httpx.HTTPError:
            self.scheduler.last_error = "backend_transport_error"
            raise ProxyError(502, "backend_transport_error") from None


def create_app(settings: Settings | None = None, *,
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """Build a single-worker gateway; the caller owns the FastAPI lifespan."""
    settings = settings or Settings()
    client = httpx.AsyncClient(
        base_url=settings.backend_url, timeout=None, transport=transport,
        follow_redirects=False, trust_env=False,
    )
    scheduler = Scheduler(settings)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await client.aclose()

    app = FastAPI(title="Breeze HTTP compatibility gateway", lifespan=lifespan)
    app.state.client = client
    app.state.scheduler = scheduler

    @app.get("/health")
    async def health():
        backend_ready = False
        sample_rate = 0
        try:
            response = await client.get("/health", timeout=2)
            value = response.json()
            sample_rate = value.get("sample_rate", 0)
            backend_ready = (response.status_code == 200 and value.get("status") == "ok"
                             and isinstance(sample_rate, int) and sample_rate > 0)
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            pass
        ready = backend_ready and not scheduler.fault and not scheduler.draining
        return JSONResponse({
            "status": "ok" if ready else "unavailable",
            "ready": bool(ready),
            "backend_ready": backend_ready,
            "sample_rate": sample_rate if backend_ready else 0,
            **scheduler.snapshot(),
        }, status_code=200 if ready else 503)

    @app.get("/v1/model")
    async def model_info():
        try:
            response = await client.get("/v1/model", timeout=5)
            if response.status_code != 200:
                return JSONResponse({"detail": "backend_model_unavailable"}, status_code=503)
            return JSONResponse(response.json())
        except (httpx.HTTPError, ValueError):
            return JSONResponse({"detail": "backend_model_unavailable"}, status_code=503)

    @app.post("/v1/audio/speech")
    async def speech(request: Request):
        return SpeechProxy(request, client, scheduler, settings)

    return app


def main() -> None:
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=["127.0.0.1", "::1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7862)
    parser.add_argument("--backend-url", default="http://127.0.0.1:7863")
    parser.add_argument("--drain-file", type=Path)
    parser.add_argument("--queue-capacity", type=int, default=8)
    parser.add_argument("--queue-timeout-ms", type=int, default=30_000)
    parser.add_argument("--job-timeout-ms", type=int, default=300_000)
    parser.add_argument("--cancel-grace-ms", type=int, default=10_000)
    args = parser.parse_args()
    settings = Settings(
        backend_url=args.backend_url, drain_file=args.drain_file,
        queue_capacity=args.queue_capacity, queue_timeout_ms=args.queue_timeout_ms,
        job_timeout_ms=args.job_timeout_ms, cancel_grace_ms=args.cancel_grace_ms,
    )
    uvicorn.run(create_app(settings), host=args.host, port=args.port, workers=1,
                access_log=False, timeout_graceful_shutdown=15)


if __name__ == "__main__":
    main()
