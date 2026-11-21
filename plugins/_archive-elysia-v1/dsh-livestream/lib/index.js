import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  DEFAULT_BOARD,
  GUEST_VOICE,
  LIVESTREAM_SESSION_ID,
  SECRETS,
  SIMULATED_PREFIX,
  asr,
  bindLivestreamAgentSetup,
  broadcast,
  checkObs,
  connectObs,
  cookie,
  currentCharacter,
  currentMoods,
  dm,
  hooks,
  initializeRuntime,
  packs,
  placeGame,
  pollQrLogin,
  prepareSpeech,
  publishBoard,
  publishNotice,
  server,
  settings,
  show,
  social,
  speakable,
  startLivestream,
  startQrLogin,
  updateSettings,
  voiceStatus,
  whoIs
} from "./chunks/chunk-VNQ5J4HE.js";

// src/config.ts
import z from "@deepseek-ai/schemastery";
import { join, resolve } from "node:path";
var home = process.env.DSH_HOME ?? "/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web";
var Config = z.object({
  baseDir: z.string().default(process.env.ELYSIA_PROMPTS_DIR ?? join(home, "standing-prompts")),
  files: z.array(z.string()).default(["SOUL.md", "USER.md", "MEMORY.md", "EXISTENCE.md", "TOOLS.md", "LIVE.md"]),
  required: z.array(z.string()).default(["SOUL.md"]),
  dataDir: z.string().default(join(home, "dsh-livestream")),
  stagePort: z.natural().max(65535).default(3300),
  publisher: z.union(["livehime", "obs"]).default("livehime"),
  allowedWriteActions: z.array(z.string()).default([])
});
function resolveConfig(config) {
  const value = Config(config);
  return { ...value, baseDir: resolve(value.baseDir), dataDir: resolve(value.dataDir ?? join(home, "dsh-livestream")) };
}

// src/core/moodText.ts
function splitByMood(text, moods) {
  const parts = [];
  let mood = "talk";
  let last = 0;
  for (const m of text.matchAll(/[[【]\s*([a-zA-Z]+)\s*[\]】]/g)) {
    const name2 = m[1].toLowerCase();
    if (!moods.includes(name2)) continue;
    parts.push({ mood, text: text.slice(last, m.index) });
    mood = name2;
    last = m.index + m[0].length;
  }
  parts.push({ mood, text: text.slice(last) });
  return parts.filter((p) => p.text.trim());
}

// src/dsh/index.ts
var name = "elysia-dsh-livestream";
var inject = ["connection", "agents", "agentDefaultModel", "agentLoop", "sessionPersistence", "sessions", "systemPrompt", "tools", "credentials"];
var localVoice = { available: false, provider: "breeze", label: "\u7231\u8389 \xB7 \u672C\u5730 Breeze" };
var json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
var fail = (message, status = 400) => json({ ok: false, error: message }, status);
async function body(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error("\u8BF7\u6C42\u8D85\u8FC7 64 KiB \u9650\u5236");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("\u8BF7\u6C42 JSON \u683C\u5F0F\u9519\u8BEF");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("\u8BF7\u6C42\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
  return value;
}
function state() {
  return {
    ok: true,
    publisher: settings.publisher,
    voice: localVoice,
    show: show.status(),
    broadcast: broadcast.status(),
    settings: { ...settings, stageToken: void 0 },
    stageUrl: server.url,
    characters: packs.list("characters"),
    templates: packs.list("templates"),
    asr: { available: asr.available },
    defaultBoard: DEFAULT_BOARD
  };
}
function cleanPace(raw) {
  const sec = (v) => v === "" || v === null || v === void 0 || !Number.isFinite(Number(v)) ? void 0 : Math.max(0, Math.min(600, Math.round(Number(v))));
  const welcome = raw.welcomeSec === "off" ? "off" : sec(raw.welcomeSec);
  const thanks = sec(raw.thanksSec), follow = sec(raw.followSec);
  const picks = sec(raw.chatPicks);
  return {
    ...welcome !== void 0 ? { welcomeSec: welcome } : {},
    ...thanks !== void 0 ? { thanksSec: thanks } : {},
    ...follow !== void 0 ? { followSec: follow } : {},
    ...picks !== void 0 ? { chatPicks: Math.max(1, Math.min(5, picks)) } : {}
  };
}
function cleanBlocked(raw) {
  const out = /* @__PURE__ */ new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const b = item;
    const uid = String(b.uid ?? "").trim();
    if (!/^\d{1,20}$/.test(uid)) continue;
    out.set(uid, { uid, name: String(b.name ?? "").trim().slice(0, 40), why: String(b.why ?? "").trim().slice(0, 200), at: Number(b.at) || Date.now() });
  }
  return [...out.values()];
}
function gameSource(value) {
  const v = value;
  const web = (x) => typeof x === "string" && /^https?:\/\//.test(x);
  if (v && web(v.url)) return { url: v.url };
  if (v && typeof v.window === "string" && v.window) return { window: v.window, ...web(v.overlay) ? { overlay: v.overlay } : {} };
  return null;
}
var simSeq = 0;
function simulated(input) {
  const name2 = (input.name ?? "").trim() || "\u6A21\u62DF\u89C2\u4F17";
  const user = { id: `${SIMULATED_PREFIX}${name2}`, name: name2, ...input.guard ? { guardLevel: input.guard } : {} };
  const base = { id: `sim-${Date.now()}-${++simSeq}`, platform: "bilibili", ts: Date.now(), user };
  switch (input.kind) {
    case "chat":
      return input.text?.trim() ? { ...base, kind: "chat", text: input.text.trim() } : null;
    case "gift":
      return { ...base, kind: "gift", giftName: input.gift || "\u5C0F\u82B1\u82B1", count: input.count ?? 1, valueYuan: input.yuan ?? 0.1 };
    case "superchat":
      return input.text?.trim() ? { ...base, kind: "superchat", text: input.text.trim(), valueYuan: input.yuan ?? 30 } : null;
    case "membership":
      return { ...base, kind: "membership", levelName: "\u8230\u957F", level: 3, count: 1, valueYuan: 138 };
    case "enter":
      return { ...base, kind: "enter" };
    case "follow":
      return { ...base, kind: "follow" };
    default:
      return null;
  }
}
var waitingOffair = null;
var endingTimer = null;
var ENDING_SCENE_MS = 17e3;
async function apply(ctx, config = {}) {
  const selected = resolveConfig(config);
  const runtime = await initializeRuntime(ctx, selected);
  const release = ctx.effect(() => () => runtime.dispose(), "elysia upstream runtime");
  try {
    bindLivestreamAgentSetup(ctx, selected);
    await server.start();
    localVoice = await voiceStatus();
  } catch (error) {
    await release();
    throw error;
  }
  ctx.provide("liveBody", {
    get onAir() {
      return show.isOnAir;
    },
    attention: (signal) => show.waitAttention(signal),
    showGame: (source) => show.showGame(gameSource(source))
  });
  ctx.effect(() => () => show.showGame(null), "dsh-livestream game screen");
  const streams = /* @__PURE__ */ new Set();
  ctx.effect(() => () => {
    if (waitingOffair) clearInterval(waitingOffair);
    waitingOffair = null;
    if (endingTimer) clearTimeout(endingTimer);
    endingTimer = null;
    for (const close of streams) close();
    streams.clear();
  }, "elysia livestream HTTP streams");
  const route = (path, methods, handler, label) => ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods,
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        return await handler(request);
      } catch (error) {
        return fail(publicError(error), 400);
      }
    }
  }), label);
  route("/api/dsh-livestream/state", ["GET"], () => json(state()), "state");
  route("/api/dsh-livestream/settings", ["POST"], async (request) => {
    const patch = await body(request);
    const next = {};
    if (patch.roomId !== void 0) {
      const room = Number(patch.roomId);
      if (!Number.isInteger(room) || room <= 0) return fail("\u623F\u95F4\u53F7\u8981\u662F\u6B63\u6574\u6570");
      next.roomId = room;
    }
    if (patch.character !== void 0) {
      if (!packs.character(String(patch.character))) return fail("\u6CA1\u6709\u8FD9\u4E2A\u89D2\u8272\u5305");
      next.character = String(patch.character);
    }
    if (patch.template !== void 0) {
      if (!packs.template(String(patch.template))) return fail("\u6CA1\u6709\u8FD9\u4E2A\u6A21\u677F");
      next.template = String(patch.template);
    }
    if (patch.voice !== void 0) {
      const voice = String(patch.voice).trim();
      if (voice && voice !== "elysia-breeze") return fail("\u58F0\u97F3\u7531\u672C\u5730 Breeze \u914D\u7F6E\u6301\u6709\uFF0C\u4E0D\u80FD\u5207\u6362\u5230\u672A\u914D\u7F6E\u7684\u97F3\u8272");
      next.voice = voice;
    }
    if (patch.idleAfterSec !== void 0) next.idleAfterSec = Math.max(10, Math.min(600, Number(patch.idleAfterSec) || 45));
    if (patch.gameChatGapSec !== void 0) next.gameChatGapSec = Math.max(5, Math.min(120, Number(patch.gameChatGapSec) || 15));
    if (patch.pace !== void 0) next.pace = cleanPace({ ...settings.pace, ...patch.pace });
    if (patch.distillModel !== void 0) return fail("\u672C\u90E8\u7F72\u4E0D\u4F7F\u7528\u72EC\u7ACB\u7684\u81EA\u52A8\u8BB0\u5FC6\u84B8\u998F\u6A21\u578B");
    if (patch.broadcast !== void 0) next.broadcast = !!patch.broadcast;
    if (patch.areaId !== void 0) next.areaId = patch.areaId ? Number(patch.areaId) : null;
    if (patch.liveTitle !== void 0) next.liveTitle = String(patch.liveTitle).slice(0, 40);
    if (patch.liveCover !== void 0) next.liveCover = String(patch.liveCover).trim().replace(/^"|"$/g, "");
    if (patch.pushProtocol !== void 0) next.pushProtocol = patch.pushProtocol === "rtmp" ? "rtmp" : "srt";
    if (patch.streamKbps !== void 0) next.streamKbps = Math.max(1e3, Math.min(12e3, Number(patch.streamKbps) || 4500));
    if (patch.asrPython !== void 0) next.asrPython = String(patch.asrPython).trim().replace(/^"|"$/g, "");
    if (patch.asrModel !== void 0) next.asrModel = String(patch.asrModel).trim() || "large-v3-turbo";
    if (patch.boardText !== void 0) next.boardText = String(patch.boardText).replace(/\r/g, "").slice(0, 1e3);
    if (patch.noticeText !== void 0) next.noticeText = String(patch.noticeText).replace(/\s+/g, " ").trim().slice(0, 200);
    if (patch.blocked !== void 0) next.blocked = cleanBlocked(patch.blocked);
    const own = patch.ownRoom;
    if (own !== void 0 && settings.roomId) {
      const rooms = new Set(settings.ownRooms);
      if (own) rooms.add(settings.roomId);
      else rooms.delete(settings.roomId);
      next.ownRooms = [...rooms];
      show.rememberViewers = own && show.status().roomId === settings.roomId;
    }
    const repaint = next.character && next.character !== settings.character || next.template && next.template !== settings.template;
    if (next.asrPython !== void 0 && next.asrPython !== settings.asrPython || next.asrModel !== void 0 && next.asrModel !== settings.asrModel) asr.close();
    updateSettings(next);
    if (next.boardText !== void 0) publishBoard();
    if (next.noticeText !== void 0) publishNotice();
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: "reload" });
    if (next.template && show.gameSource) placeGame(show.gameSource);
    return json(state());
  }, "settings");
  route("/api/dsh-livestream/connect", ["POST"], async () => {
    if (!settings.roomId) return fail("\u5148\u586B\u76F4\u64AD\u95F4\u623F\u95F4\u53F7");
    show.connect(settings.roomId, await cookie(), settings.ownRooms.includes(settings.roomId));
    return json(state());
  }, "connect");
  route("/api/dsh-livestream/disconnect", ["POST"], () => {
    show.disconnect();
    return json(state());
  }, "disconnect");
  route("/api/dsh-livestream/onair", ["POST"], async (request) => {
    const { sessionId, gameSessionId } = await body(request);
    if (sessionId !== void 0 && sessionId !== LIVESTREAM_SESSION_ID) return fail("\u53EA\u80FD\u4F7F\u7528\u5DF2\u767B\u8BB0\u7684\u7231\u8389\u76F4\u64AD\u4F1A\u8BDD", 409);
    if (gameSessionId) return fail("\u6E38\u620F\u610F\u8BC6\u5B9E\u4F8B\u5C1A\u672A\u663E\u5F0F\u7ED1\u5B9A\uFF0C\u4E0D\u80FD\u501F\u7528\u5176\u4ED6\u4F1A\u8BDD", 409);
    await startLivestream(ctx, selected);
    if (broadcast.streaming) show.markBroadcast();
    dm.newShow();
    social.newShow();
    return json(state());
  }, "onair");
  route("/api/dsh-livestream/offair", ["POST"], () => {
    show.endLive();
    if (broadcast.streaming && !waitingOffair) {
      waitingOffair = setInterval(() => {
        if (show.isOnAir) return;
        if (waitingOffair) clearInterval(waitingOffair);
        waitingOffair = null;
        endingTimer = setTimeout(() => {
          endingTimer = null;
          void broadcast.stop().catch((error) => hooks.log("warn", publicError(error)));
        }, ENDING_SCENE_MS);
      }, 1e3);
    }
    return json(state());
  }, "offair");
  route("/api/dsh-livestream/broadcast/start", ["POST"], () => {
    if (settings.publisher !== "obs") return fail("\u5F53\u524D\u7531\u672C\u673A\u76F4\u64AD\u59EC\u63A8\u6D41\uFF1B\u8BF7\u4F7F\u7528\u821E\u53F0\u6D4F\u89C8\u5668\u6E90\uFF0C\u63A7\u5236\u53F0\u53EA\u7BA1\u7406\u4E3B\u64AD\u56DE\u5E94", 409);
    broadcast.start();
    return json(state());
  }, "broadcast start");
  route("/api/dsh-livestream/broadcast/stop", ["POST"], async () => {
    if (settings.publisher !== "obs") return fail("\u5F53\u524D\u63A8\u6D41\u7531\u76F4\u64AD\u59EC\u6301\u6709\uFF0C\u8BF7\u5728\u76F4\u64AD\u59EC\u64CD\u4F5C\u4E0B\u64AD", 409);
    await broadcast.stop();
    return json(state());
  }, "broadcast stop");
  route("/api/dsh-livestream/obs/check", ["POST"], async () => {
    if (settings.publisher !== "obs") return fail("\u5F53\u524D\u9009\u62E9\u76F4\u64AD\u59EC\u53D1\u5E03\uFF0C\u672A\u6388\u6743\u63A7\u5236 OBS", 409);
    try {
      const obs = await connectObs(true);
      try {
        return json({ ok: true, ...await checkObs(obs, server.url, settings.streamKbps) });
      } finally {
        obs.close();
      }
    } catch (err) {
      return fail(err.message, 500);
    }
  }, "obs check");
  route("/api/dsh-livestream/account", ["GET"], async () => json({ ok: true, account: await whoIs(await cookie()) }), "account");
  route("/api/dsh-livestream/login/start", ["POST"], async () => {
    try {
      return json({ ok: true, ...await startQrLogin() });
    } catch (err) {
      return fail(err.message, 502);
    }
  }, "login start");
  route("/api/dsh-livestream/login/poll", ["POST"], async (request) => {
    const { key } = await body(request);
    if (!key) return fail("\u7F3A key");
    try {
      const result = await pollQrLogin(String(key));
      if (result.state !== "ok") return json({ ok: true, state: result.state, ...result.state === "error" ? { message: result.message } : {} });
      const account = await whoIs(result.cookie);
      if (!account) return json({ ok: true, state: "error", message: "\u767B\u5F55\u6210\u529F\u4E86\uFF0C\u4F46\u7528\u8FD9\u4E2A Cookie \u67E5\u4E0D\u5230\u8D26\u53F7" });
      await hooks.setSecret(SECRETS.cookie, result.cookie);
      return json({ ok: true, state: "ok", account });
    } catch (err) {
      return fail(err.message, 502);
    }
  }, "login poll");
  route("/api/dsh-livestream/orders", ["POST"], async (request) => {
    const { id, state: to, clear } = await body(request);
    const ok = ["queued", "doing", "done", "dropped"].find((s) => s === to);
    return show.ownerOrders({ id: Number(id) || void 0, state: ok, clear: !!clear }) ? json(state()) : fail("\u6CA1\u6709\u8FD9\u4E00\u5355\uFF0C\u6216\u8005\u72B6\u6001\u4E0D\u5BF9");
  }, "orders");
  route("/api/dsh-livestream/owner", ["POST"], async (request) => {
    const { text, who, line } = await body(request);
    if (!text?.trim()) return fail("\u8BF4\u70B9\u4EC0\u4E48");
    if (line === "game") return show.ownerToGame(text) ? json({ ok: true }) : fail("\u8FD9\u573A\u6CA1\u5F00\u6E38\u620F\u7EBF");
    show.ownerSay(text, who ? String(who).slice(0, 20) : void 0);
    return json({ ok: true });
  }, "owner");
  route("/api/dsh-livestream/guest", ["POST"], async (request) => {
    const { who, text, voice } = await body(request);
    if (!text?.trim()) return fail("\u8BF4\u70B9\u4EC0\u4E48");
    if (!show.isOnAir) return fail("\u6CA1\u5728\u64AD");
    const name2 = String(who ?? "").trim().slice(0, 20) || "Claude\u5C0F\u59D0";
    const said = await show.guestSay(name2, text.slice(0, 300), String(voice ?? "").trim() || GUEST_VOICE, AbortSignal.timeout(12e4));
    return json({ ok: true, said });
  }, "guest");
  route("/api/dsh-livestream/say", ["POST"], async (request) => {
    const { text, prepare } = await body(request);
    if (!text?.trim()) return fail("\u5FF5\u4EC0\u4E48");
    if (prepare) {
      for (const part of splitByMood(text.slice(0, 500), currentMoods())) prepareSpeech(speakable(part.text));
      return json({ ok: true });
    }
    if (!show.isOnAir) return fail("\u8BF7\u5148\u542F\u7528\u4E3B\u64AD\u56DE\u5E94\uFF0C\u518D\u63D0\u4EA4\u53E3\u64AD\u8BF7\u6C42");
    show.ownerSay("\u4EE5\u4E0B\u662F\u64CD\u4F5C\u8005\u7684\u53E3\u64AD\u8BF7\u6C42\uFF0C\u4E0D\u4EE3\u8868\u4F60\u5DF2\u7ECF\u8BF4\u8FC7\u3002\u662F\u5426\u91C7\u7528\u3001\u5982\u4F55\u8868\u8FBE\u7531\u4F60\u51B3\u5B9A\u3002\n\n" + text, "\u64CD\u4F5C\u8005\xB7\u53E3\u64AD\u8BF7\u6C42");
    return json({ ok: true, queued: true, said: [] });
  }, "say");
  route("/api/dsh-livestream/simulate", ["POST"], async (request) => {
    const event = simulated(await body(request));
    if (!event) return fail("\u6A21\u62DF\u7684\u4E8B\u4EF6\u4E0D\u5B8C\u6574");
    show.inject(event);
    return json({ ok: true });
  }, "simulate");
  route("/api/dsh-livestream/events", ["GET"], () => {
    let unsubscribe = null;
    let tick = null;
    let closeStream;
    const stream = new ReadableStream({
      start(controller) {
        closeStream = () => {
          unsubscribe?.();
          unsubscribe = null;
          if (tick) clearInterval(tick);
          tick = null;
          try {
            controller.close();
          } catch {
          }
          if (closeStream) streams.delete(closeStream);
        };
        streams.add(closeStream);
        const enc = new TextEncoder();
        const send = (text) => {
          try {
            controller.enqueue(enc.encode(text));
          } catch {
          }
        };
        unsubscribe = show.stage.subscribe((event) => {
          if (event.type === "hello") return;
          send(`data: ${JSON.stringify(event.type === "say" ? { ...event, audio: null } : event)}

`);
        }, false);
        const status = () => {
          send(`event: status
data: ${JSON.stringify(show.status())}

`);
          send(`event: broadcast
data: ${JSON.stringify(broadcast.status())}

`);
        };
        tick = setInterval(status, 1e3);
        status();
      },
      cancel() {
        closeStream?.();
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }, "events");
}
function publicError(error) {
  const message = error instanceof Error ? error.message : "\u76F4\u64AD\u64CD\u4F5C\u5931\u8D25";
  return message.replace(/https?:\/\/\S+/g, "[\u5730\u5740\u5DF2\u9690\u85CF]").replace(/(cookie|authorization|token|password|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[\u5DF2\u9690\u85CF]").slice(0, 300);
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
