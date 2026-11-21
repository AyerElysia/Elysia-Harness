import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts';
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts';
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { StageEvent } from '../src/stage/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'livestream-fixture-guest': { readonly kind: 'livestream-fixture-guest'; readonly id: string };
  }
}

const fixture = vi.hoisted(() => {
  const listeners = new Set<(event: StageEvent) => void>();
  const runtimeDisposed = vi.fn();
  const bindingDisposed = vi.fn();
  let owner: Context | undefined;
  const settings = {
    roomId: 42, publisher: 'livehime', character: 'fixture', template: 'fixture', voice: 'elysia-breeze',
    stagePort: 0, stageToken: 'fixture-stage-capability', distillModel: 'fixture/model',
    idleAfterSec: 45, gameChatGapSec: 15, ownRooms: [42], broadcast: false, areaId: null,
    liveTitle: '', pushProtocol: 'rtmp', streamKbps: 4500, liveCover: '',
    asrPython: '', asrModel: 'fixture', boardText: 'fixture board', noticeText: '', pace: {}, blocked: [],
  };
  const stage = {
    subscribe: vi.fn((callback: (event: StageEvent) => void, _speaker?: boolean) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    }),
    broadcast: vi.fn(),
  };
  const show = {
    isOnAir: false,
    gameSource: null,
    rememberViewers: false,
    status: vi.fn(() => ({ onAir: show.isOnAir, roomId: 42, live: { state: 'idle' }, fixture: true })),
    stage,
    goLive: vi.fn((_id: string): void => { show.isOnAir = true; }),
    markBroadcast: vi.fn(), showGame: vi.fn(), waitAttention: vi.fn(), endLive: vi.fn(),
    connect: vi.fn(), disconnect: vi.fn(), ownerOrders: vi.fn(() => true),
    ownerSay: vi.fn(), ownerToGame: vi.fn(() => false),
    guestSay: vi.fn(async () => 'fixture guest'), say: vi.fn(async () => 'fixture speech'),
    inject: vi.fn(), setNames: vi.fn(),
  };
  const server = { start: vi.fn(async () => {}), stop: vi.fn(), url: 'http://fixture.invalid/?token=fixture-stage-capability' };
  const broadcast = { streaming: false, status: vi.fn(() => ({ phase: 'idle' })), start: vi.fn(), stop: vi.fn(async () => {}) };
  const packs = {
    list: vi.fn((kind: string) => [{ id: 'fixture', name: kind, builtin: true }]),
    character: vi.fn(() => ({ names: ['Fixture'] })), template: vi.fn(() => ({ id: 'fixture' })),
  };
  const asr = { available: false, close: vi.fn() };
  const hooks = { setSecret: vi.fn(async () => {}), secret: vi.fn(async () => ''), log: vi.fn() };
  const runtime = {
    settings, show, server, broadcast, packs, asr, hooks,
    DEFAULT_BOARD: 'fixture default board', SECRETS: { cookie: 'FIXTURE_COOKIE' },
    dm: { newShow: vi.fn() }, social: { newShow: vi.fn() },
    cookie: vi.fn(async () => 'fixture-only-cookie'),
    updateSettings: vi.fn((patch: Record<string, unknown>) => { Object.assign(settings, patch); }),
    placeGame: vi.fn(), publishBoard: vi.fn(), publishNotice: vi.fn(),
    takeLive: vi.fn(), prepareSpeech: vi.fn(), agentReady: vi.fn(),
    currentCharacter: vi.fn(() => ({ names: ['Fixture'] })), currentMoods: vi.fn(() => []),
    initializeRuntime: vi.fn(),
    startLivestream: vi.fn(async (_ctx: Context, _config: unknown) => {
      show.isOnAir = true;
      return 'elysia-livestream';
    }),
  };
  const session = {
    LIVESTREAM_SESSION_ID: 'elysia-livestream',
    ensureLivestreamAgent: vi.fn(async () => ({ agent: { id: 'elysia-livestream' }, dispose: async () => {} })),
    bindLivestreamAgentSetup: vi.fn((ctx: Context) => ctx.effect(() => bindingDisposed, 'fixture scoped agent binding')),
  };
  const tts = { voiceStatus: vi.fn(async () => ({ available: true, provider: 'breeze' as const, label: 'Fixture Breeze' })) };
  const obs = { connectObs: vi.fn(), checkObs: vi.fn() };
  const login = { whoIs: vi.fn(), pollQrLogin: vi.fn(), startQrLogin: vi.fn() };
  function reset() {
    owner = undefined;
    listeners.clear();
    show.isOnAir = false;
    broadcast.streaming = false;
    settings.publisher = 'livehime';
    settings.stageToken = 'fixture-stage-capability';
    runtime.initializeRuntime.mockReset().mockImplementation(async (ctx: Context) => {
      if (owner) throw new Error('Fixture runtime already owned');
      owner = ctx;
      let disposed = false;
      return { async dispose() {
        if (disposed) return;
        disposed = true;
        runtimeDisposed();
        server.stop();
        owner = undefined;
      } };
    });
    runtime.startLivestream.mockReset().mockImplementation(async (_ctx: Context, _config: unknown) => {
      show.isOnAir = true;
      return 'elysia-livestream';
    });
    server.start.mockReset().mockResolvedValue(undefined);
    tts.voiceStatus.mockReset().mockResolvedValue({ available: true, provider: 'breeze', label: 'Fixture Breeze' });
    session.ensureLivestreamAgent.mockReset().mockResolvedValue({ agent: { id: 'elysia-livestream' }, dispose: async () => {} });
    session.bindLivestreamAgentSetup.mockReset().mockImplementation((ctx: Context) => ctx.effect(() => bindingDisposed, 'fixture scoped agent binding'));
  }
  return { runtime, session, tts, obs, login, listeners, runtimeDisposed, bindingDisposed, reset };
});

vi.mock('../src/dsh/runtime', () => fixture.runtime);
vi.mock('../src/dsh/session', () => fixture.session);
vi.mock('../src/body/tts', () => fixture.tts);
vi.mock('../src/body/obs', () => fixture.obs);
vi.mock('../src/body/biliLogin', () => fixture.login);
vi.mock('../src/body/show', () => ({ SIMULATED_PREFIX: 'fixture-sim:' }));

import { apply, Config, inject, name } from '../src/dsh/index';

const contexts: Context[] = [];
const network = vi.fn(async () => { throw new Error('No fixture may call external fetch'); });

function hostPlugin() { return { name, inject: [...inject], Config, apply }; }

async function host() {
  const ctx = new Context();
  contexts.push(ctx);
  const create = vi.fn();
  const resume = vi.fn();
  const services: Record<string, unknown> = { agents: { create, resume } };
  for (const service of inject.filter(service => service !== 'connection')) {
    (ctx.provide as (name: string, service: unknown) => void)(service, services[service] ?? {});
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth);
  const shared = connection.createSharedFetchHandler('/api');
  const owner = connection.createPeer({ principal: { kind: 'owner' } });
  const guest = connection.createPeer({ principal: { kind: 'livestream-fixture-guest', id: 'fixture' } });
  const config = { baseDir: '/fixture/no-read', files: ['SOUL.md'], required: ['SOUL.md'], dataDir: '/fixture/no-write', stagePort: 0, publisher: 'livehime' as const };
  const mount = () => ctx.plugin(hostPlugin(), config);
  const call = (path: string, options: { method?: string; body?: string; peer?: PeerScope } = {}) => shared.fetch(
    new Request('http://fixture.invalid/api/dsh-livestream/' + path, {
      method: options.method ?? 'GET',
      ...(options.body === undefined ? {} : { body: options.body, headers: { 'content-type': 'application/json' } }),
    }), options.peer ?? owner,
  );
  const mounted = mount();
  return { ctx, connection, shared, owner, guest, config, mounted, mount, call, create, resume };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('upstream livestream Host exact API', () => {
  it('rejects non-owner Peers before reaching any business operation', async () => {
    const f = await host();
    await f.mounted.await();
    const routes = [
      ['state', 'GET'], ['settings', 'POST'], ['onair', 'POST'], ['guest', 'POST'],
      ['connect', 'POST'], ['say', 'POST'], ['obs/check', 'POST'], ['broadcast/start', 'POST'],
      ['login/start', 'POST'], ['account', 'GET'], ['events', 'GET'],
    ];
    for (const [path, method] of routes) {
      expect((await f.call(path!, { method, ...(method === 'POST' ? { body: '{}' } : {}), peer: f.guest })).status).toBe(403);
    }
    for (const operation of [
      fixture.runtime.show.status, fixture.runtime.updateSettings, fixture.runtime.show.goLive,
      fixture.runtime.show.guestSay, fixture.runtime.show.connect, fixture.runtime.broadcast.start,
      fixture.runtime.startLivestream, fixture.runtime.show.ownerSay, fixture.runtime.prepareSpeech,
      fixture.obs.connectObs, fixture.login.startQrLogin, fixture.login.whoIs,
    ]) expect(operation).not.toHaveBeenCalled();
    expect(fixture.listeners.size).toBe(0);
  });

  it('serves the original owner state contract with local voice/publisher and no token setting', async () => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('state');
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state).toMatchObject({
      ok: true, publisher: 'livehime', voice: { available: true, provider: 'breeze' },
      show: { fixture: true }, broadcast: { phase: 'idle' }, settings: { roomId: 42 },
      stageUrl: fixture.runtime.server.url, characters: [{ id: 'fixture' }], templates: [{ id: 'fixture' }],
      asr: { available: false }, defaultBoard: 'fixture default board',
    });
    expect(state.settings).not.toHaveProperty('stageToken');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.shared.requestBodyMode({ method: 'POST', url: new URL('http://fixture.invalid/api/dsh-livestream/onair') })).toBe('buffered');
  });

  it.each([{}, { sessionId: 'elysia-livestream' }])('binds onair to the registered identity: %j', async input => {
    const f = await host();
    await f.mounted.await();
    const result = await f.call('onair', { method: 'POST', body: JSON.stringify(input) });
    expect(result.status).toBe(200);
    expect(fixture.runtime.startLivestream).toHaveBeenCalledExactlyOnceWith(
      expect.any(Context), expect.objectContaining({ publisher: 'livehime', stagePort: 0, baseDir: '/fixture/no-read' }),
    );
    // Host delegates recovery/identity/restore ordering to the runtime entry.
    expect(fixture.session.ensureLivestreamAgent).not.toHaveBeenCalled();
    expect(fixture.runtime.show.goLive).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(fixture.runtime.dm.newShow).toHaveBeenCalledOnce();
    expect(fixture.runtime.social.newShow).toHaveBeenCalledOnce();
  });

  it.each([
    { sessionId: 'random-session' }, { sessionId: null }, { gameSessionId: 'private-game-session' },
  ])('refuses another session before agent acquisition: %j', async input => {
    const f = await host();
    await f.mounted.await();
    expect((await f.call('onair', { method: 'POST', body: JSON.stringify(input) })).status).toBe(409);
    expect(fixture.runtime.startLivestream).not.toHaveBeenCalled();
    expect(fixture.session.ensureLivestreamAgent).not.toHaveBeenCalled();
    expect(fixture.runtime.show.goLive).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(['broadcast/start', 'broadcast/stop', 'obs/check'])('does not control OBS/Bilibili in livehime mode: %s', async path => {
    const f = await host();
    await f.mounted.await();
    expect((await f.call(path, { method: 'POST', body: '{}' })).status).toBe(409);
    expect(fixture.runtime.broadcast.start).not.toHaveBeenCalled();
    expect(fixture.runtime.broadcast.stop).not.toHaveBeenCalled();
    expect(fixture.obs.connectObs).not.toHaveBeenCalled();
    expect(fixture.obs.checkObs).not.toHaveBeenCalled();
    expect(fixture.runtime.cookie).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '"scalar"', JSON.stringify({ text: '😀'.repeat(17_000) })])('rejects malformed, non-object or oversized input (%#)', async body => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('onair', { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(fixture.session.ensureLivestreamAgent).not.toHaveBeenCalled();
    expect(fixture.runtime.show.goLive).not.toHaveBeenCalled();
  });

  it('refuses operator speech before the fixed livestream is on air', async () => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('say', { method: 'POST', body: JSON.stringify({ text: '公开口播请求。' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(fixture.runtime.show.ownerSay).not.toHaveBeenCalled();
    expect(fixture.runtime.show.say).not.toHaveBeenCalled();
    expect(fixture.runtime.prepareSpeech).not.toHaveBeenCalled();
  });

  it('queues the complete operator script for subject adoption without directly speaking it', async () => {
    const f = await host();
    await f.mounted.await();
    fixture.runtime.show.isOnAir = true;
    const script = '公开口播请求。'.repeat(120);
    const response = await f.call('say', { method: 'POST', body: JSON.stringify({ text: script }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true, said: [] });
    expect(fixture.runtime.show.ownerSay).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(script), '操作者·口播请求');
    expect(String(fixture.runtime.show.ownerSay.mock.calls[0]![0]).endsWith(script)).toBe(true);
    expect(fixture.runtime.show.say).not.toHaveBeenCalled();
    expect(fixture.runtime.prepareSpeech).not.toHaveBeenCalled();
  });

  it('allows explicit local pre-synthesis without speaking or adopting the script', async () => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('say', {
      method: 'POST', body: JSON.stringify({ text: '公开预合成测试。', prepare: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fixture.runtime.prepareSpeech).toHaveBeenCalledExactlyOnceWith('公开预合成测试。');
    expect(fixture.runtime.show.ownerSay).not.toHaveBeenCalled();
    expect(fixture.runtime.show.say).not.toHaveBeenCalled();
  });

  it('does not let settings overwrite the deployment stage capability or publisher', async () => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('settings', { method: 'POST', body: JSON.stringify({ stageToken: 'replacement', publisher: 'obs' }) });
    expect(response.status).toBe(200);
    expect(fixture.runtime.updateSettings).toHaveBeenCalledExactlyOnceWith({});
    const value = await response.json();
    expect(value.settings).not.toHaveProperty('stageToken');
    expect(value.publisher).toBe('livehime');
    expect(fixture.runtime.settings.stageToken).toBe('fixture-stage-capability');
  });

  it('redacts capability URLs from API errors', async () => {
    const f = await host();
    await f.mounted.await();
    fixture.runtime.startLivestream.mockRejectedValueOnce(new Error('fixture http://fixture.invalid/?token=example-secret'));
    const response = await f.call('onair', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('example-secret');
    expect(text).not.toContain('http://fixture.invalid');
  });

  it('withdraws routes, closes SSE and releases the runtime when its scope unloads', async () => {
    const f = await host();
    await f.mounted.await();
    const response = await f.call('events');
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(fixture.listeners.size).toBe(1);
    await f.mounted.dispose();
    let ended = false;
    for (let i = 0; i < 5; i++) {
      if ((await reader.read()).done) { ended = true; break; }
    }
    expect(ended).toBe(true);
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.runtimeDisposed).toHaveBeenCalledOnce();
    expect(fixture.runtime.server.stop).toHaveBeenCalledOnce();
    expect(fixture.bindingDisposed).toHaveBeenCalledOnce();
    expect(fixture.runtime.show.showGame).toHaveBeenCalledWith(null);
    expect((await f.call('state')).status).toBe(404);
    expect((await f.call('onair', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('cancels an owned ending-scene deadline when the host unloads', async () => {
    const f = await host();
    await f.mounted.await();
    fixture.runtime.settings.publisher = 'obs';
    fixture.runtime.broadcast.streaming = true;
    fixture.runtime.show.isOnAir = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    expect((await f.call('offair', { method: 'POST', body: '{}' })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
    await f.mounted.dispose();
    expect(fixture.runtimeDisposed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(17_000);
    expect(fixture.runtime.broadcast.stop).not.toHaveBeenCalled();
  });

  it.each(['stage', 'voice', 'binding'])('rolls back ownership after %s startup failure and permits a clean remount', async failing => {
    if (failing === 'stage') fixture.runtime.server.start.mockRejectedValueOnce(new Error('fixture startup failure'));
    if (failing === 'voice') fixture.tts.voiceStatus.mockRejectedValueOnce(new Error('fixture startup failure'));
    if (failing === 'binding') fixture.session.bindLivestreamAgentSetup.mockImplementationOnce(() => { throw new Error('fixture startup failure'); });
    const f = await host();
    await expect(f.mounted.await()).rejects.toThrow('fixture startup failure');
    expect(fixture.runtimeDisposed).toHaveBeenCalledOnce();
    expect(fixture.runtime.server.stop).toHaveBeenCalledOnce();
    expect((await f.call('state')).status).toBe(404);
    await f.mounted.dispose();
    const remounted = f.mount();
    await remounted.await();
    expect((await f.call('state')).status).toBe(200);
    expect(fixture.runtime.initializeRuntime).toHaveBeenCalledTimes(2);
    await remounted.dispose();
    expect(fixture.runtimeDisposed).toHaveBeenCalledTimes(2);
  });
});
