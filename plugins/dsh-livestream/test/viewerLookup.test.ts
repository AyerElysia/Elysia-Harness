import { describe, expect, it } from 'vitest';
import type { LiveEvent, LiveUser } from '../src/core/live';
import { lookupProblem, lookupViewer } from '../src/core/viewerLookup';

let n = 0;
const chat = (user: LiveUser): LiveEvent => ({ id: `c${++n}`, platform: 'bilibili', kind: 'chat', ts: n, user, text: 'hi' });
const events = [
  chat({ id: '101', name: '考研的阿杰' }),
  chat({ id: '102', name: '阿杰今天不加班' }),
  chat({ id: '103', name: '深海潜水员' }),
  chat({ id: '0', name: '小***', masked: true }),
  chat({ id: 'sim-测试小鲸', name: '测试小鲸' }),
];
const look = (who: string) => lookupViewer(who, events, { simulatedPrefix: 'sim-' });

describe('which viewer she means', () => {
  it('finds by UID and by the exact name', () => {
    expect(look('103')).toMatchObject({ kind: 'found', uid: '103', how: 'uid' });
    expect(look('@考研的阿杰')).toMatchObject({ kind: 'found', uid: '101', how: 'name' });
  });
  it('finds by part of a name when only one viewer fits', () => {
    expect(look('潜水员')).toMatchObject({ kind: 'found', uid: '103', how: 'partial' });
  });
  it('lists everyone a partial name fits instead of guessing', () => {
    const r = look('阿杰');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.uid).sort()).toEqual(['101', '102']);
    expect(lookupProblem('阿杰', r as never)).toContain('UID 101');
  });
  it('suggests the closest names for a typo', () => {
    const r = look('深海潜水猿');
    expect(r.kind).toBe('missing');
    expect(lookupProblem('深海潜水猿', r as never)).toContain('深海潜水员（UID 103）');
  });
  it('explains masked and rehearsal viewers', () => {
    expect(look('小***').kind).toBe('masked');
    expect(look('测试小鲸').kind).toBe('simulated');
  });
  it('takes an unseen UID but marks it', () => {
    expect(look('703007996')).toMatchObject({ kind: 'found', how: 'unseen-uid' });
  });
});
