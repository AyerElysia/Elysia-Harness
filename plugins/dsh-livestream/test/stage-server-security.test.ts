import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Packs } from '../src/body/packs';
import { StageServer } from '../src/body/server';
import { Stage, type SpeechPlaybackState } from '../src/body/stage';

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

function openSse(f: Fixture, preview = false): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path: f.auth('/events' + (preview ? '?preview=1' : '')), agent: false }, res => {
      res.on('error', () => {}); // Expected when this isolated server is stopped.
      res.resume();
      resolve(res);
    });
    req.once('error', reject);
    req.end();
  });
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
    for (const path of ['/source', '/stage']) {
      const result = await request(f, path, { headers });
      expect(result.status).toBe(401);
      expect(result.headers.location).toBeUndefined();
    }
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
    const said = vi.spyOn(f.stage, 'said').mockReturnValue(true);
    const result = await request(f, f.auth('/said?id=line-1&state=' + state + '&detail=fixture-reason'), {
      method: 'POST', headers: { origin: f.origin },
    });
    expect(result.status).toBe(204);
    expect(said).toHaveBeenCalledExactlyOnceWith('line-1', state, 'fixture-reason');
  });

  it('returns conflict for stale or unknown receipt ids', async () => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'said');
    expect((await request(f, f.auth('/said?id=stale&state=ended'), { method: 'POST' })).status).toBe(409);
    expect(said).toHaveBeenCalledExactlyOnceWith('stale', 'ended', '');
  });

  it.each([
    '/said?id=line',
    '/said?id=line&state=played',
    '/said?state=ended',
    '/said?id=bad%20id&state=ended',
    '/said?id=' + 'x'.repeat(201) + '&state=ended',
  ])('rejects missing or invalid receipt fields before calling Stage: %s', async path => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'said').mockReturnValue(true);
    expect((await request(f, f.auth(path), { method: 'POST' })).status).toBe(400);
    expect(said).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/said?id=line&state=ended&preview=1', origin: undefined },
    { path: '/said?id=line&state=ended', origin: 'https://foreign.invalid' },
    { path: '/said?id=line&state=ended', origin: 'null' },
  ])('blocks preview and cross-origin acknowledgements: %j', async ({ path, origin }) => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'said').mockReturnValue(true);
    const result = await request(f, f.auth(path), { method: 'POST', headers: origin ? { origin } : {} });
    expect(result.status).toBe(403);
    expect(said).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated receipt posts before calling Stage', async () => {
    const f = await fixture();
    const said = vi.spyOn(f.stage, 'said').mockReturnValue(true);
    expect((await request(f, '/said?id=line&state=ended', { method: 'POST' })).status).toBe(401);
    expect(said).not.toHaveBeenCalled();
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
