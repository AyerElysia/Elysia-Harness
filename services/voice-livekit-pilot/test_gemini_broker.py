"""Offline broker contract tests using fake LiveKit and provider boundaries."""

import asyncio
import base64
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

import gemini_broker as broker

BRIDGE_KEY = "isolated-fixture-key-with-no-access"
HOST = {"Host": "127.0.0.1:18794"}
AUTH = {**HOST, "Authorization": "Bearer " + BRIDGE_KEY}
ROOM_NAME = "elysia-gemini-cascade-" + "a" * 32
TEXT = {"messages": [
    {"role": "system", "content": "Literal fixture SOUL."},
    {"role": "user", "content": "你好。"},
]}


class BrokerContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rooms = SimpleNamespace(
            create_room=AsyncMock(), delete_room=AsyncMock(),
            list_rooms=AsyncMock(return_value=SimpleNamespace(rooms=[])),
        )
        self.fixture = broker.Broker(
            SimpleNamespace(room=self.rooms), "fixture", "f" * 40,
            broker.GeminiConfig(broker.LOOPBACK_ENDPOINT, broker.GEMINI_MODEL, "inert-token"), None,
        )
        self.ready = True
        self.client = TestClient(TestServer(broker.make_app(self.fixture, BRIDGE_KEY, lambda: self.ready)))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_only_service_bearer_exact_host_and_no_browser_origin(self):
        for headers in (
            HOST,
            {**AUTH, "Host": "localhost:18794"},
            {**AUTH, "Origin": "http://127.0.0.1:3299"},
            {**HOST, "Authorization": "Bearer wrong"},
        ):
            async with self.client.post("/start", json={}, headers=headers) as reply:
                self.assertEqual(reply.status, 403)
                self.assertEqual(await reply.json(), {"error": "pilot_forbidden"})
        self.rooms.create_room.assert_not_called()
        async with self.client.get("/health", headers=HOST) as reply:
            self.assertEqual(await reply.json(), {"ready": True, "mode": "gemini-cascade-pilot"})
        self.ready = False
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 503)

    async def test_start_rejects_mode_mismatch_before_minting_token(self):
        async with self.client.post("/start", json={"inputMode": "local-asr"}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 409)
        self.fixture.input_mode = "local-asr"
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 409)
        self.rooms.create_room.assert_not_called()

    async def test_main_turn_requires_local_asr_and_marks_trusted_dispatch(self):
        request = {"inputMode": "local-asr", "turnMode": "main-session"}
        async with self.client.post("/start", json=request, headers=AUTH) as reply:
            self.assertEqual(reply.status, 409)
        self.rooms.create_room.assert_not_called()
        self.fixture.input_mode = "local-asr"
        health = AsyncMock()
        health.__aenter__.return_value.status = 200
        self.fixture.model_http = SimpleNamespace(get=lambda *_args, **_kwargs: health)
        for invalid in (
            {**request, "turnMode": "isolated"},
            {**request, "inputMode": "direct-audio"},
            {**request, "sessionId": "other"},
        ):
            async with self.client.post("/start", json=invalid, headers=AUTH) as reply:
                self.assertEqual(reply.status, 409)
        self.rooms.create_room.assert_not_called()
        async with self.client.post("/start", json=request, headers=AUTH) as reply:
            self.assertEqual(reply.status, 200)
            call = await reply.json()
        self.assertEqual(call["turnMode"], "main-session")
        self.assertEqual(json.loads(self.rooms.create_room.await_args.args[0].agents[0].metadata), {
            "participantIdentity": call["participantIdentity"], "turnMode": "main-session",
        })
        token = call["participantToken"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        self.assertFalse(claims["video"]["canPublishData"])
        self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])

    async def test_room_grants_dispatch_and_stop_only_exact_owner(self):
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 200)
            self.assertEqual(reply.headers["Cache-Control"], "no-store")
            call = await reply.json()
        self.assertEqual(set(call), {"roomName", "serverUrl", "participantToken", "participantIdentity", "inputMode"})
        self.assertRegex(call["roomName"], broker.ROOM)
        self.assertEqual(call["inputMode"], "direct-audio")
        self.assertEqual(call["serverUrl"], broker.LIVEKIT_URL)
        room = self.rooms.create_room.await_args.args[0]
        self.assertEqual(room.name, call["roomName"])
        self.assertEqual(room.agents[0].agent_name, broker.AGENT)
        self.assertEqual(json.loads(room.agents[0].metadata), {"participantIdentity": call["participantIdentity"]})
        self.assertEqual(room.max_participants, 2)
        self.assertFalse(room.replay_enabled)
        encoded = call["participantToken"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        self.assertEqual(claims["sub"], call["participantIdentity"])
        self.assertEqual(claims["exp"] - claims["nbf"], broker.JOIN_SECONDS)
        self.assertNotIn("roomConfig", claims)
        self.assertEqual(claims["video"]["room"], call["roomName"])
        self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])
        self.assertTrue(claims["video"]["canPublishData"])
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 409)
        async with self.client.post("/stop", json={"roomName": ROOM_NAME}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 404)
        self.rooms.delete_room.assert_not_called()
        for _ in range(2):
            async with self.client.post("/stop", json={"roomName": call["roomName"]}, headers=AUTH) as reply:
                self.assertEqual(await reply.json(), {"ok": True})
        self.rooms.delete_room.assert_awaited_once()
        self.assertEqual(self.rooms.delete_room.await_args.args[0].room, call["roomName"])

    async def test_failed_create_reconciles_only_reserved_room(self):
        self.rooms.create_room.side_effect = TimeoutError
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 503)
        reserved = self.rooms.create_room.await_args.args[0].name
        self.assertEqual(self.rooms.delete_room.await_args.args[0].room, reserved)
        self.assertIsNone(self.fixture.active)

    async def test_failed_stop_preserves_owner(self):
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            room = (await reply.json())["roomName"]
        self.rooms.delete_room.side_effect = TimeoutError
        async with self.client.post("/stop", json={"roomName": room}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 503)
        self.assertEqual(self.fixture.active[0], room)
        async with self.client.post("/start", json={}, headers=AUTH) as reply:
            self.assertEqual(reply.status, 409)
        self.rooms.delete_room.side_effect = None
        await self.fixture.aclose()
        self.assertIsNone(self.fixture.active)

    async def test_text_stream_uses_bound_model_and_never_records_input(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def stream(model, _http, messages):
            self.assertEqual(model.model, "gemini-3.8-flash")
            self.assertEqual(messages, TEXT["messages"])
            started.set()
            await release.wait()
            yield "你好"
            yield "，收到。"

        with patch.object(broker, "stream_reply", stream):
            task = asyncio.create_task(self.client.post("/text", json=TEXT, headers=AUTH))
            try:
                await asyncio.wait_for(started.wait(), 2)
                async with self.client.post("/start", json={}, headers=AUTH) as reply:
                    self.assertEqual(reply.status, 409)
                release.set()
                async with await task as reply:
                    self.assertEqual(await reply.json(), {"text": "你好，收到。"})
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(self.fixture.text_active)
        self.rooms.create_room.assert_not_called()

    async def test_invalid_text_and_incomplete_model_output(self):
        for body in (
            {"messages": [{"role": "user", "content": ["audio"]}]},
            {"messages": [{"role": ["user"], "content": "test"}]},
            {"messages": [{"role": "assistant", "content": "test"}]},
            {"messages": [{"role": "user", "content": "\ud800"}]},
            {"messages": [{"role": "user", "content": "x" * (broker.MAX_MESSAGE_BYTES + 1)}]},
        ):
            async with self.client.post("/text", json=body, headers=AUTH) as reply:
                self.assertEqual(reply.status, 400)

        async def capped(*_args):
            yield "a" * broker.MAX_OUTPUT_CHARS

        with patch.object(broker, "stream_reply", capped):
            async with self.client.post("/text", json=TEXT, headers=AUTH) as reply:
                self.assertEqual(reply.status, 502)
                self.assertEqual(await reply.json(), {"error": "pilot_text_incomplete"})


class ProtectedFiles(unittest.TestCase):
    def test_private_file_refuses_public_mode_and_symlink(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture"
            path.write_bytes(b"fixture-only")
            os.chmod(path, 0o600)
            self.assertEqual(broker.read_private(path, 20), b"fixture-only")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                broker.read_private(link, 20)
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(RuntimeError, "pilot_private_file_invalid"):
                broker.read_private(path, 20)


if __name__ == "__main__":
    unittest.main()
