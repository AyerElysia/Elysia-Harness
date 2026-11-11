import { afterEach, describe, expect, it, vi } from 'vitest';

describe('livehime sign', () => {
  afterEach(() => vi.useRealTimers());
  it('matches the StartLive signer for the same payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ code: 0, message: '', data: { rtmp: { addr: 'rtmp://x/', code: 'k' } } }));
    });
    const { BiliRoom } = await import('../src/body/biliRoom');
    await new BiliRoom('DedeUserID=1; bili_jct=abc').start(123, 235);
    const sign = new URLSearchParams(calls[0].body).get('sign');
    // python: md5(urlencode(sorted(params)) + appsec)
    expect(sign).toBe('dd376801c64db312404ebb9e0c702790');
  });
});

describe('cover size', () => {
  it('reads JPEG and PNG dimensions without decoding', async () => {
    const { imageSize } = await import('../src/body/biliRoom');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, '..', 'assets', 'templates', 'default');
    const jpg = fs.readdirSync(dir).find((f: string) => f.endsWith('.jpg'));
    if (jpg) {
      const size = imageSize(new Uint8Array(fs.readFileSync(path.join(dir, jpg))));
      expect(size?.width).toBeGreaterThan(0);
      expect(size?.height).toBeGreaterThan(0);
    }
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(png.buffer).setUint32(16, 1600);
    new DataView(png.buffer).setUint32(20, 1200);
    expect(imageSize(png)).toEqual({ width: 1600, height: 1200 });
  });
});

describe('same cover', () => {
  it('matches Bilibili image URLs by the image SHA1', async () => {
    const { sameCover } = await import('../src/body/biliRoom');
    const { createHash } = await import('node:crypto');
    const data = new TextEncoder().encode('a cover');
    const sha = createHash('sha1').update(data).digest('hex');
    expect(sameCover(`http://i0.hdslb.com/bfs/live/new_room_cover/${sha}.jpg`, data)).toBe(true);
    expect(sameCover('http://i0.hdslb.com/bfs/live/new_room_cover/0000.jpg', data)).toBe(false);
    expect(sameCover('', data)).toBe(false);
  });
});
