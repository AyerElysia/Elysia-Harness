import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleTransport, type ConsoleEvent } from '../src/console/transport';

const owned: ConsoleTransport[] = [];
function transport(fetch: (input: string, init: RequestInit) => Promise<Response>) { const t = new ConsoleTransport(fetch); owned.push(t); return t; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { for (const t of owned.splice(0)) t.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('authenticated console transport ownership', () => {
  it('uses document-relative routes on the public shell fetch and never reads a secret', async () => {
    const carrier = vi.fn(async () => new Response('{"ok":true,"voice":{"available":true}}', { headers: { 'content-type': 'application/json' } }));
    const raw = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('__DSH_TRANSPORT__', { fetch: carrier }); vi.stubGlobal('fetch', raw);
    const t = new ConsoleTransport(); owned.push(t);
    expect(await t.request('state')).toEqual({ ok: true, voice: { available: true } });
    expect(carrier).toHaveBeenCalledWith('api/dsh-livestream/state', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
    expect(raw).not.toHaveBeenCalled();
  });
  it('reports an authenticated route refusal instead of returning an empty state', async () => {
    const t = transport(async () => new Response('{}', { status: 401 }));
    await expect(t.request('state')).rejects.toThrow('HTTP 401');
  });
  it('parses named, multiline and split UTF-8 events, and cancels the reader on disposal', async () => {
    const encoder = new TextEncoder();
    let control!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const cancel = vi.fn();
    const t = transport(async (_url, init) => {
      signal = init.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(c) { control = c; }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const events: ConsoleEvent[] = [];
    const status = vi.fn();
    t.follow(event => events.push(event), status);
    await settle();
    const bytes = encoder.encode('event: status\r\ndata: {"text":\r\ndata: "爱莉"}\r\n\r\ndata: {"type":"brain"}\n\n');
    for (let offset = 0; offset < bytes.length; offset += 2) control.enqueue(bytes.slice(offset, offset + 2));
    await vi.waitFor(() => { expect(events).toHaveLength(2); });
    expect(events[0]).toEqual({ event: 'status', data: '{"text":\n"爱莉"}' });
    expect(events[1]!.event).toBe('message');
    t.dispose(); await settle();
    expect(signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect(status.mock.calls).toEqual([[null]]);
  });
  it('cancels retry delay and never reconnects after plugin removal', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const t = transport(fetch); const status = vi.fn();
    t.follow(() => {}, status); await settle();
    expect(status).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    t.dispose(); await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a late unary response after cancellation instead of publishing stale state', async () => {
    let respond!: (response: Response) => void;
    const t = transport(() => new Promise(resolve => { respond = resolve; }));
    const result = t.request('state');
    t.dispose();
    const cancel = vi.fn();
    respond(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await expect(result).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('cancels a stream response arriving after disposal without delivering data', async () => {
    let respond!: (response: Response) => void;
    const t = transport(() => new Promise(resolve => { respond = resolve; }));
    const receive = vi.fn(), status = vi.fn(), cancel = vi.fn();
    t.follow(receive, status); t.dispose();
    respond(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'text/event-stream' } }));
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1); expect(receive).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
});
