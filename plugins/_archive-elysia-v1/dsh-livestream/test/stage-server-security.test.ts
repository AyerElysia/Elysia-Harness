import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Packs } from '../src/body/packs';
import { StageServer } from '../src/body/server';
import { Stage, type SpeechPlaybackState } from '../src/body/stage';
import type { StageEvent } from '../src/stage/protocol';

const FIXTURE_PLAYBACK_ID = '9b2b0434-23f5-4b05-82c3-1c8b87a69a0a';

interface Fixture {
  root: string;
  server: StageServer;
  stage: Stage;
  origin: string;
  port: number;
  auth(path: string): string;
}

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stage-security-'));
  const packageDir = join(root, 'package');
  const userDir = join(root, 'user');
  const characterDir = join(packageDir, 'assets', 'characters', 'fixture');
  const templateDir = join(packageDir, 'assets', 'templates', 'fixture');
  for (const dir of [join(packageDir, 'stage'), join(packageDir, 'lib'), characterDir, templateDir, userDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(packageDir, 'stage', 'index.html'), '<!doctype html><title>Fixture stage</title>');
  writeFileSync(join(packageDir, 'stage', 'stage.css'), 'body { margin: 0 }');
  writeFileSync(join(packageDir, 'lib', 'stage.js'), '/* fixture stage bundle */');
  writeFileSync(join(characterDir, 'character.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', clips: {} }));
  writeFileSync(join(templateDir, 'template.json'), JSON.stringify({ id: 'fixture', name: 'Fixture' }));
  writeFileSync(join(characterDir, 'visible.txt'), 'VISIBLE_FIXTURE');
  writeFileSync(join(templateDir, 'style.css'), '/* fixture template */');
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE_ONLY_FIXTURE');
  symlinkSync(join(root, 'outside.txt'), join(characterDir, 'escape.txt'));
  symlinkSync(join(characterDir, 'visible.txt'), join(characterDir, 'internal.txt'));
  symlinkSync(root, join(characterDir, 'escape-dir'));
  const stage = new Stage();
  const token = 'isolated-fixture-token';
  const server = new StageServer({
    port: 0, token, packageDir, packs: new Packs(packageDir, userDir), stage,
    current: () => ({ character: 'fixture', template: 'fixture' }),
  });
  await server.start();
  const address = new URL(server.url);
  const result: Fixture = {
    root, server, stage, origin: address.origin, port: Number(address.port),
    auth: path => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token),
  };
  fixtures.push(result);
  return result;
}

function request(f: Fixture, path: string, options: { method?: string; headers?: IncomingHttpHeaders } = {}): Promise<{
  status: number; headers: IncomingHttpHeaders; body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port: f.port, path, method: options.method ?? 'GET',
      headers: { host: '127.0.0.1:' + f.port, ...options.headers }, agent: false,
    }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.once('error', reject);
    });
    req.setTimeout(1500, () => req.destroy(new Error('Isolated fixture request timed out')));
    req.once('error', reject);
    req.end();
  });
}

function subscribeSse(f: Fixture, path: string): Promise<{ response: IncomingMessage; events: StageEvent[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path, agent: false }, response => {
      req.setTimeout(0);
      const events: StageEvent[] = [];
      let pending = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        pending += chunk;
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const message = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (message.startsWith('data: ')) events.push(JSON.parse(message.slice(6)) as StageEvent);
        }
      });
      response.on('error', () => {}); // Expected when this isolated server is stopped.
      resolve({ response, events });
    });
    req.setTimeout(1500, () => req.destroy(new Error('Isolated fixture SSE connection timed out')));
    req.once('error', reject);
    req.end();
  });
}

async function openSse(f: Fixture, preview = false): Promise<IncomingMessage> {
  return (await subscribeSse(f, f.auth('/events' + (preview ? '?preview=1' : '')))).response;
}

async function sourceCapability(f: Fixture, alias: '/audio' | '/subtitles' | '/listen'): Promise<(path: string) => string> {
  const bootstrap = await request(f, alias);
  expect(bootstrap.status).toBe(302);
  const page = new URL(String(bootstrap.headers.location), f.origin);
  expect(page.pathname).toBe(alias);
  expect((await request(f, page.pathname + page.search)).status).toBe(200);
  const token = page.searchParams.get('token');
  expect(token).not.toBeNull();
  expect(token).not.toBe('isolated-fixture-token');
  return path => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token ?? '');
}

async function playbackId(events: StageEvent[]): Promise<string> {
  return vi.waitFor(() => {
    const owner = events.find(event => event.type === 'playback-owner');
    if (!owner) throw new Error('No playback identity in this fixture SSE connection');
    return owner.playbackId;
  });
}

function publishFixtureSpeech(f: Fixture, id: string, signal = new AbortController().signal) {
  const receipt = f.stage.waitSaid(id, 1000, signal);
  f.stage.broadcast({ type: 'say', id, text: 'fixture words', mood: 'normal', audio: 'FIXTURE_AUDIO', audioMime: 'audio/wav', estimateMs: 1000, timeline: [{ chars: 13, atMs: 1000 }] });
  return receipt;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.server.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('stage server capability boundary', () => {
  it('requires authentication for the page, bundle, packs and SSE', async () => {
    const f = await fixture();
    for (const path of ['/', '/stage.js', '/characters/fixture/visible.txt', '/events']) {
      expect((await request(f, path)).status).toBe(401);
    }
    expect((await request(f, '/?token=wrong')).status).toBe(401);
    expect((await request(f, '/?token=' + 'x'.repeat(513))).status).toBe(401);
  });

  it.each(['/source', '/stage'])('bootstraps %s only for a direct local source', async path => {
    const f = await fixture();
    const result = await request(f, path);
    expect(result.status).toBe(302);
    expect(result.headers['cache-control']).toBe('no-store');
    const target = new URL(String(result.headers.location), f.origin);
    expect(target.origin).toBe(f.origin);
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('token')).toBe('isolated-fixture-token');
    expect(target.searchParams.get('preview')).toBe(path === '/stage' ? '1' : null);
  });

  it.each([
    { forwarded: 'for=127.0.0.1' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-proto': 'https' },
    { 'cf-connecting-ip': '127.0.0.1' },
    { host: 'public.invalid' },
  ])('does not reveal a bootstrap capability through forwarding or a foreign host: %j', async headers => {
    const f = await fixture();
    for (const path of ['/source', '/stage', '/audio', '/subtitles', '/listen']) {
      const result = await request(f, path, { headers });
      expect(result.status).toBe(401);
      expect(result.headers.location).toBeUndefined();
    }
  });

  it('keeps the listening capability on direct loopback for every allowed route', async () => {
    const f = await fixture();
    const listen = await sourceCapability(f, '/listen');
    expect(listen('/events')).not.toBe((await sourceCapability(f, '/audio'))('/events'));
    for (const path of ['/listen', '/events', '/stage.js', '/stage.css']) {
      expect((await request(f, listen(path), { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
    }
    for (const path of ['/', '/source', '/stage', '/audio', '/subtitles', '/events?preview=1', '/video?id=fixture', '/characters/fixture/visible.txt']) {
      expect((await request(f, listen(path))).status).toBe(403);
    }
    expect((await request(f, f.auth('/listen'))).status).toBe(403);
    expect((await request(f, listen('/said'), { method: 'POST', headers: { origin: 'https://other.invalid' } })).status).toBe(403);
    expect((await request(f, listen('/said'), { method: 'POST', headers: { host: 'public.invalid' } })).status).toBe(403);
    expect((await request(f, listen('/media'), { method: 'POST' })).status).toBe(403);
  });

  it('does not upgrade an explicitly supplied bad or empty token', async () => {
    const f = await fixture();
    for (const path of ['/source?token=', '/stage?token=wrong']) {
      expect((await request(f, path)).status).toBe(401);
    }
  });

  it('serves authorised assets with no-referrer and nosniff', async () => {
    const f = await fixture();
    const result = await request(f, f.auth('/stage.js'));
    expect(result.status).toBe(200);
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.body).toBe('/* fixture stage bundle */');
  });
});

describe('stage speech receipt validation', () => {
  it.each(['ended', 'failed', 'cancelled', 'timeout'] as const)('forwards an accepted %s receipt exactly once', async (state: SpeechPlaybackState) => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback').mockReturnValue(true);
    const result = await request(f, f.auth('/said?id=line-1&state=' + state + '&detail=fixture-reason&playbackId=' + FIXTURE_PLAYBACK_ID), {
      method: 'POST', headers: { origin: f.origin },
    });
    expect(result.status).toBe(204);
    expect(said).toHaveBeenCalledExactlyOnceWith('full', FIXTURE_PLAYBACK_ID, 'line-1', { state, detail: 'fixture-reason' });
  });

  it('returns conflict for stale or unknown receipt ids', async () => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback');
    expect((await request(f, f.auth('/said?id=stale&state=ended&playbackId=' + FIXTURE_PLAYBACK_ID), { method: 'POST' })).status).toBe(409);
    expect(said).toHaveBeenCalledExactlyOnceWith('full', FIXTURE_PLAYBACK_ID, 'stale', { state: 'ended', detail: '' });
  });

  it.each([
    '/said?id=line',
    '/said?id=line&state=played',
    '/said?state=ended',
    '/said?id=bad%20id&state=ended',
    '/said?id=' + 'x'.repeat(201) + '&state=ended',
    '/said?id=line&state=started&positionMs=Infinity',
    '/said?id=line&state=started&durationMs=0',
    '/said?id=line&state=started&positionMs=300&durationMs=200',
  ])('rejects missing or invalid receipt fields before calling Stage: %s', async path => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback').mockReturnValue(true);
    expect((await request(f, f.auth(path + '&playbackId=' + FIXTURE_PLAYBACK_ID), { method: 'POST' })).status).toBe(400);
    expect(said).not.toHaveBeenCalled();
  });

  it('requires the playback identity for every network receipt', async () => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback');
    expect((await request(f, f.auth('/said?id=line&state=ended'), { method: 'POST' })).status).toBe(400);
    expect(said).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/said?id=line&state=ended&preview=1', origin: undefined },
    { path: '/said?id=line&state=ended', origin: 'https://foreign.invalid' },
    { path: '/said?id=line&state=ended', origin: 'null' },
  ])('blocks preview and cross-origin acknowledgements: %j', async ({ path, origin }) => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback').mockReturnValue(true);
    const result = await request(f, f.auth(path), { method: 'POST', headers: origin ? { origin } : {} });
    expect(result.status).toBe(403);
    expect(said).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated receipt posts before calling Stage', async () => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'reportPlayback').mockReturnValue(true);
    expect((await request(f, '/said?id=line&state=ended', { method: 'POST' })).status).toBe(401);
    expect(said).not.toHaveBeenCalled();
  });
});

describe('independent browser sources', () => {
  it('limits the subtitle capability to captions and keeps it out of the speaker set', async () => {
    const f = await fixture();
    const subtitles = await sourceCapability(f, '/subtitles');
    const audio = await sourceCapability(f, '/audio');
    expect(subtitles('/events')).not.toBe(audio('/events'));
    for (const path of ['/source', '/audio', '/video?id=fixture', '/characters/fixture/visible.txt']) {
      expect((await request(f, subtitles(path))).status).toBe(403);
    }
    expect((await request(f, subtitles('/said?id=line&state=ended&mode=audio&playbackId=' + FIXTURE_PLAYBACK_ID), { method: 'POST' })).status).toBe(403);
    expect((await request(f, subtitles('/media?id=fixture&state=playing'), { method: 'POST' })).status).toBe(403);
    expect((await request(f, audio('/video?id=fixture'))).status).toBe(403);
    const captions = await subscribeSse(f, subtitles('/events?mode=audio'));
    expect(captions.response.statusCode).toBe(200);
    expect(f.stage.watchers).toBe(0);
    expect(await publishFixtureSpeech(f, 'silent')).toMatchObject({ state: 'failed', detail: 'no-speaking-stage' });
    expect(captions.events.every(event => event.type === 'hello')).toBe(true);
  });

  it('delivers audio to one owner, starts captions from its receipt, and reconnects captions without audio', async () => {
    const f = await fixture();
    const audio = await sourceCapability(f, '/audio');
    const subtitles = await sourceCapability(f, '/subtitles');
    const combined = await subscribeSse(f, f.auth('/events'));
    const dedicated = await subscribeSse(f, audio('/events'));
    const captions = await subscribeSse(f, subtitles('/events'));
    const preview = await subscribeSse(f, f.auth('/events?preview=1'));
    const [combinedId, dedicatedId] = await Promise.all([playbackId(combined.events), playbackId(dedicated.events)]);
    expect(f.stage.watchers).toBe(2);

    const receipt = publishFixtureSpeech(f, 'line');
    await vi.waitFor(() => expect(dedicated.events.find(event => event.type === 'say')).toMatchObject({ id: 'line', audio: 'FIXTURE_AUDIO' }));
    await vi.waitFor(() => expect(preview.events.find(event => event.type === 'say')).toMatchObject({ id: 'line', audio: null }));
    expect(combined.events.some(event => event.type === 'say')).toBe(false);
    expect(captions.events.some(event => event.type === 'subtitle')).toBe(false);

    const post = (auth: (path: string) => string, id: string, state: string) =>
      request(f, auth('/said?id=line&playbackId=' + id + '&state=' + state), { method: 'POST' });
    expect((await post(f.auth, combinedId, 'started')).status).toBe(409);
    expect((await post(f.auth, dedicatedId, 'started')).status).toBe(409);
    expect((await post(subtitles, dedicatedId, 'started')).status).toBe(403);
    expect((await post(audio, dedicatedId, 'ended')).status).toBe(409);
    expect((await post(audio, dedicatedId, 'started&positionMs=150&durationMs=1000')).status).toBe(204);
    expect((await post(audio, dedicatedId, 'started')).status).toBe(409);

    const started = await vi.waitFor(() => {
      const event = captions.events.find(event => event.type === 'subtitle');
      expect(event).toMatchObject({ type: 'subtitle', id: 'line', state: 'started', text: 'fixture words', elapsedMs: 150, estimateMs: 1000 });
      return event!;
    });
    expect(started).not.toHaveProperty('audio');
    expect(captions.events.some(event => event.type === 'say' || event.type === 'playback-owner')).toBe(false);
    await vi.waitFor(() => expect(combined.events).toContainEqual(started));
    expect(captions.events.filter(event => event.type === 'subtitle')).toHaveLength(1);
    const reconnected = await subscribeSse(f, subtitles('/events'));
    await vi.waitFor(() => {
      const replay = reconnected.events.find(event => event.type === 'subtitle' && event.state === 'started');
      expect(replay).toMatchObject({ id: 'line', state: 'started' });
      if (replay?.state === 'started') expect(replay.elapsedMs).toBeGreaterThanOrEqual(150);
    });

    expect((await post(audio, dedicatedId, 'ended')).status).toBe(204);
    expect((await post(audio, dedicatedId, 'ended')).status).toBe(409);
    expect(await receipt).toMatchObject({ id: 'line', state: 'ended' });
    await vi.waitFor(() => {
      for (const source of [captions, combined, dedicated, reconnected]) {
        expect(source.events).toContainEqual(expect.objectContaining({ type: 'subtitle', id: 'line', state: 'ended' }));
      }
    });
  });

  it('prefers a local rehearsal listener and keeps it separate from publishing sources', async () => {
    const f = await fixture();
    f.stage.allowListeningWhen(() => true);
    const listen = await sourceCapability(f, '/listen');
    const audio = await sourceCapability(f, '/audio');
    const subtitles = await sourceCapability(f, '/subtitles');
    const local = await subscribeSse(f, listen('/events'));
    const dedicated = await subscribeSse(f, audio('/events'));
    const captions = await subscribeSse(f, subtitles('/events'));
    const [localId, dedicatedId] = await Promise.all([playbackId(local.events), playbackId(dedicated.events)]);
    expect(f.stage.watchers).toBe(1);

    const receipt = publishFixtureSpeech(f, 'rehearsal');
    await vi.waitFor(() => expect(local.events).toContainEqual(expect.objectContaining({ type: 'say', id: 'rehearsal', audio: 'FIXTURE_AUDIO' })));
    const post = (auth: (path: string) => string, ticket: string, state: string) =>
      request(f, auth('/said?id=rehearsal&playbackId=' + ticket + '&state=' + state), { method: 'POST' });
    expect((await post(audio, dedicatedId, 'started')).status).toBe(409);
    expect((await post(audio, localId, 'started')).status).toBe(409);
    expect((await post(listen, localId, 'started')).status).toBe(204);
    expect((await post(listen, localId, 'ended')).status).toBe(204);
    expect(await receipt).toMatchObject({ state: 'ended' });
    await vi.waitFor(() => expect(local.events).toContainEqual(expect.objectContaining({ type: 'subtitle', id: 'rehearsal', state: 'ended' })));
    expect(dedicated.events.some(event => event.type === 'say')).toBe(false);
    expect(captions.events.some(event => event.type === 'subtitle')).toBe(false);
  });

  it('revokes active rehearsal playback when a room or stream starts and never replays that line', async () => {
    const f = await fixture();
    let localAllowed = true;
    f.stage.allowListeningWhen(() => localAllowed);
    const listen = await sourceCapability(f, '/listen');
    const audio = await sourceCapability(f, '/audio');
    const local = await subscribeSse(f, listen('/events'));
    const dedicated = await subscribeSse(f, audio('/events'));
    const [localId, dedicatedId] = await Promise.all([playbackId(local.events), playbackId(dedicated.events)]);
    const post = (auth: (path: string) => string, ticket: string, line: string, state: string) =>
      request(f, auth('/said?id=' + line + '&playbackId=' + ticket + '&state=' + state), { method: 'POST' });
    const revoked = publishFixtureSpeech(f, 'rehearsal');
    expect((await post(listen, localId, 'rehearsal', 'started')).status).toBe(204);
    localAllowed = false;
    expect(await revoked).toMatchObject({ id: 'rehearsal', state: 'cancelled', detail: 'local-listening-disabled' });
    await vi.waitFor(() => expect(local.events).toContainEqual(expect.objectContaining({ type: 'subtitle', id: 'rehearsal', state: 'cancelled' })));
    expect((await post(listen, localId, 'rehearsal', 'ended')).status).toBe(409);

    const next = publishFixtureSpeech(f, 'published');
    await vi.waitFor(() => expect(dedicated.events).toContainEqual(expect.objectContaining({ type: 'say', id: 'published' })));
    expect((await post(audio, dedicatedId, 'published', 'started')).status).toBe(204);
    expect((await post(audio, dedicatedId, 'published', 'ended')).status).toBe(204);
    expect(await next).toMatchObject({ id: 'published', state: 'ended' });
    expect(dedicated.events.filter(event => event.type === 'say').map(event => event.id)).toEqual(['published']);
    expect(local.events.filter(event => event.type === 'say').map(event => event.id)).toEqual(['rehearsal']);
  });

  it('keeps an ineligible local listener idle and supports a sole local listener when eligible', async () => {
    const f = await fixture();
    const listen = await sourceCapability(f, '/listen');
    const local = await subscribeSse(f, listen('/events'));
    const ticket = await playbackId(local.events);
    expect(f.stage.watchers).toBe(0);
    expect(f.stage.listenWatchers).toBe(0);
    expect(await publishFixtureSpeech(f, 'ineligible')).toMatchObject({ state: 'failed', detail: 'no-speaking-stage' });
    f.stage.allowListeningWhen(() => true);
    expect(f.stage.listenWatchers).toBe(1);
    const receipt = publishFixtureSpeech(f, 'local-only');
    await vi.waitFor(() => expect(local.events).toContainEqual(expect.objectContaining({ type: 'say', id: 'local-only' })));
    expect(local.events.filter(event => event.type === 'say').map(event => event.id)).toEqual(['local-only']);
    const post = (state: string) =>
      request(f, listen('/said?id=local-only&playbackId=' + ticket + '&state=' + state), { method: 'POST' });
    expect((await post('started')).status).toBe(204);
    expect((await post('ended')).status).toBe(204);
    expect(await receipt).toMatchObject({ state: 'ended' });
  });

  it('lets the audio source own a guest sentence when no combined source is open', async () => {
    const f = await fixture();
    const audio = await sourceCapability(f, '/audio');
    const dedicated = await subscribeSse(f, audio('/events'));
    const ticket = await playbackId(dedicated.events);
    const receipt = f.stage.waitSaid('guest', 1000, new AbortController().signal);
    f.stage.broadcast({ type: 'say', id: 'guest', text: 'guest fixture', speaker: 'guest', mood: '', audio: 'FIXTURE_AUDIO', estimateMs: 1000 });
    await vi.waitFor(() => expect(dedicated.events).toContainEqual(expect.objectContaining({ type: 'say', id: 'guest', speaker: 'guest' })));
    const ack = (state: string) => request(f, audio('/said?id=guest&playbackId=' + ticket + '&state=' + state), { method: 'POST' });
    expect((await ack('started')).status).toBe(204);
    expect((await ack('ended')).status).toBe(204);
    expect(await receipt).toMatchObject({ state: 'ended' });
  });

  it('fails a disconnected owner without replaying audio on standby and uses standby for a new line', async () => {
    const f = await fixture();
    const audio = await sourceCapability(f, '/audio');
    const combined = await subscribeSse(f, f.auth('/events'));
    const dedicated = await subscribeSse(f, audio('/events'));
    const [combinedId, dedicatedId] = await Promise.all([playbackId(combined.events), playbackId(dedicated.events)]);
    const lost = publishFixtureSpeech(f, 'lost');
    await vi.waitFor(() => expect(dedicated.events.some(event => event.type === 'say')).toBe(true));
    dedicated.response.destroy();
    expect(await lost).toMatchObject({ state: 'failed', detail: 'speaking-stage-disconnected' });
    expect(combined.events.some(event => event.type === 'say')).toBe(false);
    expect((await request(f, audio('/said?id=lost&state=started&playbackId=' + dedicatedId), { method: 'POST' })).status).toBe(409);

    const next = publishFixtureSpeech(f, 'next');
    await vi.waitFor(() => expect(combined.events).toContainEqual(expect.objectContaining({ type: 'say', id: 'next' })));
    const newAudio = await subscribeSse(f, audio('/events'));
    await playbackId(newAudio.events);
    expect(newAudio.events.some(event => event.type === 'say')).toBe(false);
    expect((await request(f, f.auth('/said?id=next&state=failed&playbackId=' + combinedId), { method: 'POST' })).status).toBe(204);
    expect(await next).toMatchObject({ state: 'failed' });
  });
});

describe('stage resource and shutdown boundaries', () => {
  it('serves pack files and symlinks that remain within the pack', async () => {
    const f = await fixture();
    for (const path of ['/characters/fixture/visible.txt', '/characters/fixture/internal.txt']) {
      const result = await request(f, f.auth(path));
      expect(result.status).toBe(200);
      expect(result.body).toBe('VISIBLE_FIXTURE');
    }
    expect((await request(f, f.auth('/templates/fixture/style.css'))).status).toBe(200);
  });

  it.each([
    '/characters/fixture/..%2f..%2f..%2f..%2foutside.txt',
    '/characters/fixture/%2e%2e%2foutside.txt',
    '/characters/fixture/escape.txt',
    '/characters/fixture/escape-dir/outside.txt',
  ])('denies traversal or a symlink escape: %s', async path => {
    const f = await fixture();
    const result = await request(f, f.auth(path));
    expect(result.status).toBe(403);
    expect(result.body).not.toContain('OUTSIDE_ONLY_FIXTURE');
  });

  it('keeps an authenticated SSE preview silent and outside the speaker set', async () => {
    const f = await fixture();
    const res = await openSse(f, true);
    expect(res.statusCode).toBe(200);
    expect(f.stage.watchers).toBe(0);
    const closed = new Promise<void>(resolve => res.once('close', resolve));
    f.server.stop();
    await closed;
  });

  it('closes an active SSE connection and its Stage subscription on stop', async () => {
    const f = await fixture();
    const res = await openSse(f);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(f.stage.watchers).toBe(1);
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE remained open after stop')), 1500);
      res.once('close', () => { clearTimeout(timer); resolve(); });
      res.once('error', () => {});
    });
    f.server.stop();
    await closed;
    await vi.waitFor(() => expect(f.stage.watchers).toBe(0));
  });
});
