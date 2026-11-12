"""Exercise the actual aiohttp token route without starting a server or provider."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

import pilot


class TokenRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        dist = Path(self.temp.name) / "frontend" / "dist"
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>fixture</title>")
        livekit = SimpleNamespace(room=SimpleNamespace(list_rooms=AsyncMock()))
        with patch.object(pilot, "HERE", Path(self.temp.name)):
            self.client = TestClient(TestServer(pilot.make_app("fake", "f" * 40, livekit)))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.host = {"Host": pilot.WEB_HOST}
        async with self.client.get("/", headers=self.host) as response:
            self.assertEqual(response.status, 200)
            self.assertTrue(response.cookies[pilot.COOKIE]["httponly"])
            self.assertEqual(response.cookies[pilot.COOKIE]["samesite"], "Strict")
            self.cookie = f"{pilot.COOKIE}={response.cookies[pilot.COOKIE].value}"
        self.client.session.cookie_jar.clear()

    async def test_requires_same_origin_and_cookie(self):
        for headers in (
            {**self.host, "Cookie": self.cookie},
            {**self.host, "Origin": pilot.ORIGIN},
            {**self.host, "Origin": "https://elsewhere.invalid", "Cookie": self.cookie},
            {"Host": "elsewhere.invalid", "Origin": pilot.ORIGIN, "Cookie": self.cookie},
        ):
            async with self.client.post("/api/token", json={}, headers=headers) as response:
                self.assertEqual(response.status, 403)

    async def test_issues_room_specific_mic_only_short_token_and_guards_duplicate(self):
        headers = {**self.host, "Origin": pilot.ORIGIN, "Cookie": self.cookie}
        async with self.client.post("/api/token", json={"roomName": "arbitrary"}, headers=headers) as response:
            self.assertEqual(response.status, 400)
        async with self.client.post("/api/token", json={}, headers=headers) as response:
            self.assertEqual(response.status, 200)
            body = await response.json()
        self.assertEqual(body["serverUrl"], pilot.LIVEKIT_URL)
        self.assertRegex(body["roomName"], r"^elysia-voice-pilot-[0-9a-f]{32}$")
        payload = body["participantToken"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        self.assertEqual(claims["exp"] - claims["nbf"], pilot.JOIN_SECONDS)
        self.assertEqual(claims["video"]["room"], body["roomName"])
        self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])
        self.assertFalse(claims["video"]["canPublishData"])
        self.assertEqual(claims["roomConfig"]["agents"][0]["agentName"], pilot.AGENT_NAME)
        self.assertEqual(json.loads(claims["roomConfig"]["agents"][0]["metadata"])["participantIdentity"], claims["sub"])
        async with self.client.post("/api/token", json={}, headers=headers) as response:
            self.assertEqual(response.status, 409)
