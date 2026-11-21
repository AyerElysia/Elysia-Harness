import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { decodeBiliMessage } from '../src/core/platforms/bilibili/biliDecode';
import { readPb } from '../src/core/platforms/bilibili/protobuf';
import { readFrame, makeAuthPacket, OP } from '../src/core/platforms/bilibili/biliProtocol';
import { signWbi } from '../src/core/platforms/bilibili/biliApi';
import { LiveHub } from '../src/core/hub';
import type { LiveEvent, LiveGiftEvent } from '../src/core/live';
import zlib from 'zlib';

const FIXTURES = path.join(__dirname, 'fixtures', 'bilibili');
const load = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const hasFixtures = fs.existsSync(path.join(FIXTURES, 'busy-login.jsonl'));
/** 雪狐桑的直播间（录制用的大房间） */
const BUSY = { realRoomId: 24393, anchorId: '477792' };

function decodeAll(name: string) {
  const events: LiveEvent[] = [];
  const stats: Record<string, unknown>[] = [];
  for (const msg of load(name)) {
    for (const out of decodeBiliMessage(msg, BUSY, msg.t)) {
      if (out.type === 'event') events.push(out.event);
      else if (out.type === 'stats') stats.push(out.stats);
    }
  }
  return { events, stats };
}

describe.runIf(hasFixtures)('bilibili decode (real recordings)', () => {
  it('reads chat, gifts, superchats, memberships, enters and likes from a busy room', () => {
    const { events } = decodeAll('busy-login.jsonl');
    const byKind = (k: string) => events.filter((e) => e.kind === k);
    expect(byKind('chat').length).toBe(263);
    expect(byKind('enter').length).toBe(342);
    expect(byKind('gift').length).toBe(10);
    expect(byKind('superchat').length).toBe(1);
    expect(byKind('membership').length).toBe(1);
    expect(byKind('like').length).toBe(20);
    // 登录后没有打码
    expect(events.filter((e) => e.user.masked).length).toBe(0);
  });

  it('decodes protobuf gifts with names and prices', () => {
    const gifts = decodeAll('busy-login.jsonl').events.filter((e): e is LiveGiftEvent => e.kind === 'gift');
    const letter = gifts.find((g) => g.giftName === '情书');
    expect(letter).toMatchObject({ user: { name: '往事淡若微风', id: '491622619' }, count: 1, valueYuan: 5.2 });
    expect(letter!.user.medal).toEqual({ name: '雪狐咕', level: 23, ofThisRoom: true });
    expect(gifts.find((g) => g.giftName === '粉丝团灯牌')?.valueYuan).toBe(0.1);
  });

  it('decodes protobuf enters with medals of this room vs other rooms', () => {
    const enters = decodeAll('busy-login.jsonl').events.filter((e) => e.kind === 'enter');
    expect(enters.every((e) => e.user.name && e.user.id)).toBe(true);
    const withMedal = enters.filter((e) => e.user.medal);
    expect(withMedal.some((e) => e.user.medal!.ofThisRoom)).toBe(true);
    expect(withMedal.some((e) => !e.user.medal!.ofThisRoom)).toBe(true);
  });

  it('marks sticker danmaku as emote-only and keeps their ids unique', () => {
    const chats = decodeAll('busy-login.jsonl').events.filter((e) => e.kind === 'chat');
    expect(new Set(chats.map((c) => c.id)).size).toBe(chats.length);
    const emotes = chats.filter((c) => c.kind === 'chat' && c.emoteOnly);
    expect(emotes.length).toBeGreaterThan(50);
    expect(emotes.length).toBeLessThan(chats.length / 2);
  });

  it('reads the online count and watched total', () => {
    const { stats } = decodeAll('busy-login.jsonl');
    expect(stats.filter((s) => 'online' in s).at(-1)).toEqual({ online: 2348 });
    expect(stats.filter((s) => 'watched' in s).at(-1)).toEqual({ watched: 18565 });
  });

  it('flags masked viewers on an anonymous connection', () => {
    const { events } = decodeAll('busy-anon.jsonl');
    const chats = events.filter((e) => e.kind === 'chat');
    const masked = chats.filter((e) => e.user.masked);
    expect(masked.length / chats.length).toBeGreaterThan(0.7);
    expect(masked.every((e) => e.user.id === '')).toBe(true);
  });
});

describe('bilibili protocol', () => {
  it('splits brotli frames into messages', () => {
    const inner = (obj: unknown) => {
      const body = Buffer.from(JSON.stringify(obj));
      const h = Buffer.alloc(16);
      h.writeUInt32BE(16 + body.length, 0); h.writeUInt16BE(16, 4); h.writeUInt16BE(0, 6); h.writeUInt32BE(5, 8);
      return Buffer.concat([h, body]);
    };
    const packed = zlib.brotliCompressSync(Buffer.concat([inner({ cmd: 'A' }), inner({ cmd: 'B' })]));
    const outer = Buffer.alloc(16);
    outer.writeUInt32BE(16 + packed.length, 0); outer.writeUInt16BE(16, 4); outer.writeUInt16BE(3, 6); outer.writeUInt32BE(5, 8);
    const auth = Buffer.from('{"code":0}');
    const authHead = Buffer.alloc(16);
    authHead.writeUInt32BE(16 + auth.length, 0); authHead.writeUInt16BE(16, 4); authHead.writeUInt32BE(8, 8);
    const packets = readFrame(Buffer.concat([Buffer.concat([outer, packed]), authHead, auth]));
    expect(packets).toEqual([
      { op: OP.MESSAGE, message: { cmd: 'A' } },
      { op: OP.MESSAGE, message: { cmd: 'B' } },
      { op: OP.AUTH_REPLY, ok: true, code: 0 },
    ]);
  });

  it('builds an auth packet with buvid', () => {
    const p = makeAuthPacket({ roomId: 1, uid: 2, buvid: 'b', token: 't' });
    expect(p.readUInt32BE(8)).toBe(OP.AUTH);
    expect(JSON.parse(p.subarray(16).toString())).toMatchObject({ uid: 2, roomid: 1, buvid: 'b', key: 't', protover: 3 });
  });

  it('signs WBI queries the way the web client does', () => {
    // 已知输入的官方示例（bilibili-API-collect 文档）
    const q = signWbi({ foo: '114', bar: '514', zab: 1919810 }, 'ea1db124af3c7062474693fa704f4ff8', 1702204169);
    expect(q).toBe('bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  });

  it('reads protobuf varints above 2^53 as exact ids', () => {
    // field 1 = 3546392410721100 (varint)
    const n = 3546392410721100n;
    const bytes: number[] = [0x08];
    let v = n;
    while (v >= 0x80n) { bytes.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    bytes.push(Number(v));
    expect(readPb(Buffer.from(bytes)).get(1)).toEqual([n]);
  });
});

describe('LiveHub', () => {
  const user = { id: '1', name: 'a' };
  const gift = (id: string, ts: number): LiveGiftEvent => ({ id, platform: 'bilibili', kind: 'gift', ts, user, giftName: '灯牌', count: 1, valueYuan: 0.1 });
  const hub = () => new LiveHub(() => ({ platform: 'bilibili', start() {}, stop() {} }));

  it('merges a gift combo into one event and reports the update', () => {
    const h = hub();
    const seen: Array<[number, boolean]> = [];
    h.subscribe((e, isUpdate) => e.kind === 'gift' && seen.push([e.count, isUpdate]));
    h.ingest(gift('g1', 0), 0);
    h.ingest(gift('g1', 1000), 1000);
    h.ingest(gift('g1', 2000), 2000);
    expect(seen).toEqual([[1, false], [2, true], [3, true]]);
    expect(h.recentEvents()).toHaveLength(1);
    expect(h.recentEvents()[0]).toMatchObject({ count: 3, valueYuan: 0.3 });
  });

  it('starts a new gift event when the combo went quiet', () => {
    const h = hub();
    h.ingest(gift('g1', 0), 0);
    h.ingest(gift('g1', 60_000), 60_000);
    expect(h.recentEvents().map((e) => (e as LiveGiftEvent).count)).toEqual([1, 1]);
  });

  it('drops repeated events and counts per minute', () => {
    const h = hub();
    const chat = (id: string): LiveEvent => ({ id, platform: 'bilibili', kind: 'chat', ts: 0, user, text: 'hi' });
    h.ingest(chat('c1'), 0);
    h.ingest(chat('c1'), 10);
    h.ingest(chat('c2'), 20);
    expect(h.recentEvents()).toHaveLength(2);
    expect(h.status(30).perMinute).toEqual({ chat: 2 });
    expect(h.status(70_000).perMinute).toEqual({});
  });
});
