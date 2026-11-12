"""Offline worker tests: all job/media/provider operations are fakes."""

import asyncio
import json
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import agent

ROOM = "elysia-voice-pilot-" + "a" * 32
USER = "pilot-browser-123"
METADATA = json.dumps({"participantIdentity": USER})


class Room:
    def __init__(self):
        self.handlers = {}
        self.remote_participants = {USER: SimpleNamespace(identity=USER)}

    def on(self, event, handler):
        self.handlers[event] = handler

    def off(self, event, handler):
        assert self.handlers.pop(event) is handler

    def leave(self, identity=USER):
        self.handlers["participant_disconnected"](SimpleNamespace(identity=identity))


class PilotTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_admits_only_explicit_pilot_room_and_identity(self):
        job = SimpleNamespace(room=SimpleNamespace(name=ROOM), metadata=METADATA)
        req = SimpleNamespace(job=job, accept=AsyncMock(), reject=AsyncMock())
        await agent._request(req)
        req.accept.assert_awaited_once()
        req.reject.assert_not_awaited()
        job.room.name = "unrelated-room"
        await agent._request(req)
        req.reject.assert_awaited_once()
        self.assertIsNone(agent.dispatch_identity(ROOM, "{}"))
        self.assertIsNone(agent.dispatch_identity(ROOM, '{"participantIdentity":"<invalid>"}'))
        self.assertIsNone(agent.dispatch_identity(ROOM, '{"participantIdentity":"u","tools":[]}'))

    def test_soul_read_is_literal_and_never_loads_adjacent_files(self):
        with tempfile.TemporaryDirectory() as directory:
            soul = Path(directory) / "SOUL.md"
            body = "模拟提示 {{literal}}\r\n"
            soul.write_bytes(body.encode("utf-8"))
            other = Path(directory) / "USER.md"
            other.write_text("must never read", encoding="utf-8")
            self.assertEqual(agent.read_soul(str(soul)), body)
            with self.assertRaisesRegex(ValueError, "pilot_soul_unavailable"):
                agent.read_soul(str(other))
            with self.assertRaisesRegex(ValueError, "pilot_soul_unavailable"):
                agent.read_soul("SOUL.md")
            soul.write_bytes(b"x" * (agent.MAX_SOUL_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "pilot_soul_invalid"):
                agent.read_soul(str(soul))

    async def test_waits_for_linked_caller_then_uses_text_only_and_closes_on_hangup(self):
        room = Room()
        ctx = SimpleNamespace(
            room=room,
            job=SimpleNamespace(room=SimpleNamespace(name=ROOM), metadata=METADATA),
            connect=AsyncMock(),
            wait_for_participant=AsyncMock(),
            shutdown=Mock(),
        )
        joined = asyncio.Event()
        entered = asyncio.Event()
        async def start_session(*_args, **_kwargs):
            entered.set()

        async def join(**_kwargs):
            await joined.wait()

        ctx.wait_for_participant.side_effect = join
        session = SimpleNamespace(on=Mock(), start=AsyncMock(side_effect=start_session), aclose=AsyncMock())
        http = SimpleNamespace(close=AsyncMock())
        breeze = SimpleNamespace(aclose=AsyncMock())
        logging_level = logging.root.manager.disable
        self.addCleanup(logging.disable, logging_level)
        with (
            patch.object(agent, "read_soul", return_value="fixture SOUL\r\n"),
            patch.object(agent.BreezeSettings, "from_config", return_value=object()),
            patch.object(agent, "BreezeTTS", return_value=breeze),
            patch.object(agent.aiohttp, "ClientSession", return_value=http) as http_factory,
            patch.object(agent.openai.realtime, "RealtimeModel", return_value=object()) as model_factory,
            patch.object(agent, "AgentSession", return_value=session),
            patch.object(agent, "Agent") as agent_factory,
            patch.dict(agent.os.environ, {"OPENAI_API_KEY": "offline-fixture"}),
        ):
            task = asyncio.create_task(agent.pilot(ctx))
            await asyncio.sleep(0)
            model_factory.assert_not_called()
            joined.set()
            await asyncio.wait_for(entered.wait(), timeout=1)
            room.leave("unrelated-identity")
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            room.leave()
            await asyncio.wait_for(task, timeout=1)

        self.assertEqual(ctx.wait_for_participant.await_args.kwargs["identity"], USER)
        http_factory.assert_called_once_with(proxy=agent.OPENAI_PROXY, trust_env=False)
        self.assertEqual(model_factory.call_args.kwargs["model"], "gpt-realtime-2.1-mini")
        self.assertEqual(model_factory.call_args.kwargs["modalities"], ["text"])
        self.assertEqual(model_factory.call_args.kwargs["tool_choice"], "none")
        self.assertIs(model_factory.call_args.kwargs["http_session"], http)
        agent_factory.assert_called_once_with(instructions="fixture SOUL\r\n", tools=[])
        start = session.start.await_args.kwargs
        self.assertIs(start["record"], False)
        self.assertIs(start["session_host"], False)
        self.assertEqual(start["room_options"].participant_identity, USER)
        self.assertIs(start["room_options"].text_input, False)
        self.assertIs(start["room_options"].text_output, False)
        session.aclose.assert_awaited_once()
        http.close.assert_awaited_once()
        breeze.aclose.assert_awaited_once()
        ctx.shutdown.assert_called_once_with(reason="pilot_participant_left")
        self.assertEqual(room.handlers, {})


if __name__ == "__main__":
    unittest.main()
