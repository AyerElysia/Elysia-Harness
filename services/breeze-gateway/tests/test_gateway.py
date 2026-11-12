"""Offline contracts: no models, actual backend, or platform messages."""
import asyncio
from pathlib import Path
import tempfile
import time
import unittest

from fastapi import Request
import httpx

from gateway import create_app, ProxyError, Scheduler, Settings, SpeechProxy, Ticket


class Audio(httpx.AsyncByteStream):
    def __init__(self, gate=None):
        self.gate = gate
        self.closed = False

    async def __aiter__(self):
        yield b"\x01\x00"
        if self.gate:
            await self.gate.wait()
        yield b"\x02\x00"

    async def aclose(self):
        self.closed = True


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.aclose()

    def app(self, handler, **kwargs):
        app = create_app(Settings(**kwargs), transport=httpx.MockTransport(handler))
        self.clients.append(app.state.client)
        return app

    async def post(self, app, body=b"text=hello"):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/v1/audio/speech", content=body,
                                     headers={"content-type": "application/x-www-form-urlencoded"})

    async def test_raw_request_and_audio_contract(self):
        received = []
        async def handler(request):
            received.append(request.content)
            return httpx.Response(200, headers={
                "content-type": "audio/pcm", "x-sample-rate": "24000", "x-sample-format": "s16le"
            }, stream=Audio())
        app = self.app(handler)
        response = await self.post(app, b"text=%5B%E7%AC%91%5D&seed=42")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x01\x00\x02\x00")
        self.assertEqual(response.headers["x-sample-rate"], "24000")
        self.assertEqual(received, [b"text=%5B%E7%AC%91%5D&seed=42"])
        self.assertFalse(app.state.scheduler.snapshot()["busy"])

    async def test_non_pcm_rejected(self):
        app = self.app(lambda request: httpx.Response(200, json={"not": "audio"}))
        response = await self.post(app)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "backend_audio_protocol_error")

    async def test_409_retries_only_before_inference(self):
        count = 0
        async def handler(request):
            nonlocal count
            count += 1
            if count == 1:
                return httpx.Response(409, json={"detail": "busy"})
            return httpx.Response(200, headers={
                "content-type": "audio/pcm", "x-sample-rate": "24000", "x-sample-format": "s16le"
            }, stream=Audio())
        app = self.app(handler)
        self.assertEqual((await self.post(app)).status_code, 200)
        self.assertEqual(count, 2)

    async def test_fifo_cancelled_waiter_and_capacity(self):
        scheduler = Scheduler(Settings(queue_capacity=1))
        first = Ticket("first")
        async with scheduler.slot(first, time.monotonic() + 3):
            second = Ticket("second")
            async def wait_second():
                async with scheduler.slot(second, time.monotonic() + 3):
                    self.fail("cancelled queued request entered")
            waiter = asyncio.create_task(wait_second())
            await asyncio.sleep(0)
            with self.assertRaises(ProxyError) as caught:
                async with scheduler.slot(Ticket("overflow"), time.monotonic() + 1):
                    self.fail("overflow entered")
            self.assertEqual(caught.exception.code, "gateway_queue_full")
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertEqual(len(scheduler.waiting), 0)
            self.assertIs(scheduler.active, first)
        self.assertIsNone(scheduler.active)

    async def test_queue_deadline(self):
        scheduler = Scheduler(Settings(queue_timeout_ms=5))
        async with scheduler.slot(Ticket("active"), time.monotonic() + 1):
            with self.assertRaises(ProxyError) as caught:
                async with scheduler.slot(Ticket("waiting"), time.monotonic() + 1):
                    self.fail("deadline entered")
            self.assertEqual(caught.exception.code, "gateway_queue_timeout")
        self.assertFalse(scheduler.waiting)

    async def test_drain_rejects_new_and_health_distinguishes_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "drain"
            path.touch()
            app = self.app(lambda request: httpx.Response(200, json={"status": "ok", "sample_rate": 24000}),
                           drain_file=path)
            self.assertEqual((await self.post(app)).status_code, 503)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                health = (await client.get("/health")).json()
                self.assertFalse(health["ready"])
                self.assertTrue(health["backend_ready"])
                self.assertTrue(health["drained"])

    async def test_disconnect_closes_upstream_without_audio_success_end(self):
        gate = asyncio.Event()
        audio = Audio(gate)
        async def handler(request):
            return httpx.Response(200, headers={
                "content-type": "audio/pcm", "x-sample-rate": "24000", "x-sample-format": "s16le"
            }, stream=audio)
        client = httpx.AsyncClient(base_url="http://127.0.0.1:7863", transport=httpx.MockTransport(handler))
        self.clients.append(client)
        scheduler = Scheduler(Settings())
        scope = {"type": "http", "method": "POST", "path": "/v1/audio/speech",
                 "headers": [(b"content-type", b"application/x-www-form-urlencoded")]}
        proxy = SpeechProxy(Request(scope), client, scheduler, Settings())
        incoming = asyncio.Queue()
        await incoming.put({"type": "http.request", "body": b"text=hello", "more_body": False})
        frames = []
        first_chunk = asyncio.Event()
        async def send(frame):
            frames.append(frame)
            if frame["type"] == "http.response.body" and frame.get("body"):
                first_chunk.set()
        serving = asyncio.create_task(proxy(scope, incoming.get, send))
        await asyncio.wait_for(first_chunk.wait(), 1)
        await incoming.put({"type": "http.disconnect"})
        await asyncio.wait_for(serving, 1)
        self.assertTrue(audio.closed)
        self.assertIsNone(scheduler.active)
        self.assertFalse(any(frame["type"] == "http.response.body" and not frame.get("more_body") for frame in frames))

    def test_rejects_non_loopback_or_credentials(self):
        for url in ("https://example.com", "http://secret:token@127.0.0.1:7863", "http://10.0.0.1:7863"):
            with self.assertRaises(ValueError):
                Settings(backend_url=url)


if __name__ == "__main__":
    unittest.main()
