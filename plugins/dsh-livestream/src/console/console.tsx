/**
 * 主人控制台：连直播间、开播下播、OBS 地址、换模板和角色、舞台预览、看弹幕、跟她说话、模拟观众。
 *
 * 开播由宿主恢复爱莉固定直播会话并启动直播身体（/onair）。之后往会话里推事情的是身体（宿主端），
 * 这一页关掉也不影响直播。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { ConsoleTransport } from './transport';

// ── DSH 服务 ──────────────────────────────────────────

export interface ConsoleServices {
  uiWorkspace: { openSession(sessionId: string): void };
  sessions: {
    using<T>(target: string, options: { source: string }, operation: (reference: { ready: Promise<{ session: any }> }) => T | Promise<T>): Promise<T>;
  };
  layout: { selectPanel(panelId: string | null): void };
}

export interface Credentials {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured?: boolean } | undefined> }>;
  set(ref: string, value: string): Promise<unknown>;
}

let services: ConsoleServices | null = null;
let requests: ConsoleTransport | null = null;
let credentials: Credentials | null = null;
const serviceListeners = new Set<() => void>();
let serviceVersion = 0;

export function bindConsole(next: ConsoleServices | null): void {
  requests?.dispose();
  requests = next ? new ConsoleTransport() : null;
  source = null;
  services = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

export function bindCredentials(next: Credentials | null): void {
  credentials = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

function useCredentials(): Credentials | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return credentials;
}

function useServices(): ConsoleServices | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return services;
}

// ── 宿主接口 ──────────────────────────────────────────

const SECRET_REFS = { cookie: 'BILIBILI_COOKIE' } as const;

interface PackEntry { id: string; name: string; builtin: boolean }
interface SpokenLine { text: string; mood: string; at: number }
interface ShowStatus {
  live: { state: string; room?: { title?: string; anchorName?: string; realRoomId?: number }; loggedIn: boolean; stats: { online?: number; live?: boolean }; perMinute: Record<string, number>; lastError?: string };
  onAir: boolean;
  brain: 'off' | 'listening' | 'thinking' | 'speaking' | 'away';
  brainSession: string | null;
  heat: string;
  audience: boolean;
  pending: Record<string, number>;
  lines: SpokenLine[];
  stageWatchers: number;
  roomId: number | null;
}
interface BroadcastStatus {
  phase: 'idle' | 'preparing' | 'face' | 'streaming' | 'stopping' | 'error';
  step: string;
  roomId: number | null;
  faceQr: string | null;
  error: string | null;
  health: { active: boolean; timecode: string; skipped: number; total: number; renderSkipped: number; outputSkipped: number; kbps: number } | null;
  startedAt: number | null;
}
interface HostState {
  ok: boolean;
  show: ShowStatus;
  broadcast: BroadcastStatus;
  settings: { publisher?: 'livehime' | 'obs'; roomId: number | null; character: string; template: string; voice: string; stagePort: number; idleAfterSec: number; gameChatGapSec?: number; distillModel: string; ownRooms: number[]; broadcast: boolean; areaId: number | null; liveTitle: string; pushProtocol: 'srt' | 'rtmp'; streamKbps: number; asrPython: string; asrModel: string; boardText: string; noticeText?: string; pace?: { welcomeSec?: number | 'off'; thanksSec?: number; followSec?: number; chatPicks?: number }; blocked?: BlockedViewer[] };
  stageUrl: string;
  characters: PackEntry[];
  templates: PackEntry[];
  asr: { available: boolean };
  defaultBoard: string;
  voice?: { available: boolean; provider: 'breeze'; label?: string; error?: string };
  publisher?: 'livehime' | 'obs';
}

async function api<T = HostState>(path: string, body?: unknown): Promise<T> {
  if (!requests) throw new Error('直播控制台连接未就绪，请刷新页面');
  return requests.request<T>(path, body);
}

// ── 事件流 ────────────────────────────────────────────

interface FeedRow { key: string; kind: string; uid: string; name: string; text: string; yuan?: number; at: number }

interface Live {
  status: ShowStatus | null;
  broadcast: BroadcastStatus | null;
  feed: FeedRow[];
  focus: Set<string>;
  brainDetail: string;
  transportError: string | null;
  transportConnected: boolean;
}

let live: Live = { status: null, broadcast: null, feed: [], focus: new Set(), brainDetail: '', transportError: null, transportConnected: false };
const liveListeners = new Set<() => void>();
let source: ConsoleTransport | null = null;
let feedSeq = 0;

function setLive(change: (l: Live) => Live): void {
  live = change(live);
  for (const l of liveListeners) l();
}

function connectFeed(): void {
  if (source || !requests) return;
  source = requests;
  const active = source;
  active.follow(frame => {
    if (source !== active) return;
    if (frame.event === 'status') { setLive(l => ({ ...l, status: JSON.parse(frame.data) as ShowStatus })); return; }
    if (frame.event === 'broadcast') { setLive(l => ({ ...l, broadcast: JSON.parse(frame.data) as BroadcastStatus })); return; }
    if (frame.event !== 'message') return;
    const e = JSON.parse(frame.data);
    if (e.type === 'live') {
      const ev = e.event;
      if (e.isUpdate && ev.kind !== 'gift') return;
      const text = ev.kind === 'chat' || ev.kind === 'superchat' ? ev.text
        : ev.kind === 'gift' ? `送出 ${ev.gift} ×${ev.count}`
          : ev.kind === 'membership' ? `开通了${ev.level}`
            : ev.kind === 'enter' ? '进入直播间' : '关注了直播间';
      setLive((l) => {
        const existing = l.feed.findIndex((r) => r.key === ev.id);
        const row: FeedRow = { key: ev.id, kind: ev.kind, uid: ev.user.id, name: ev.user.name, text, yuan: ev.yuan, at: Date.now() };
        const feed = existing >= 0 ? l.feed.map((r, i) => (i === existing ? row : r)) : [...l.feed, row].slice(-200);
        return { ...l, feed };
      });
    } else if (e.type === 'say') {
      setLive((l) => ({ ...l, feed: [...l.feed, { key: `say-${++feedSeq}`, kind: 'her', uid: '', name: '她', text: e.text, at: Date.now() }].slice(-200) }));
    } else if (e.type === 'focus') {
      setLive((l) => ({ ...l, focus: new Set(e.userIds) }));
    } else if (e.type === 'brain') {
      setLive((l) => ({ ...l, brainDetail: e.detail ?? '' }));
    }
  }, error => {
    if (source === active) setLive(l => ({ ...l, transportError: error, transportConnected: error === null }));
  });
}

/** Release the browser connection and service references when the plugin unloads. */
export function disposeConsole(): void {
  source?.dispose();
  source = null;
  bindConsole(null);
  bindCredentials(null);
  live = { status: null, broadcast: null, feed: [], focus: new Set(), brainDetail: '', transportError: null, transportConnected: false };
  for (const listener of liveListeners) listener();
}

function useLive(): Live {
  useEffect(connectFeed, []);
  return useSyncExternalStore((l) => { liveListeners.add(l); return () => liveListeners.delete(l); }, () => live);
}

// ── 开播：会话 ────────────────────────────────────────

async function cancel(svc: ConsoleServices, sessionId: string): Promise<void> {
  await svc.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
    const { session } = await reference.ready;
    await session.cancel();
  });
}

// ── 小组件 ────────────────────────────────────────────

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return <i className={`dl-dot dl-${tone}`} />;
}

const BRAIN_TEXT = { off: '没在播', listening: '在听弹幕', thinking: '正在想', speaking: '在说话', away: '暂时走开了' } as const;
const CONN_TEXT: Record<string, string> = { idle: '没连接', connecting: '连接中', connected: '已连上', reconnecting: '重连中', error: '连接出错' };

function useBusy(): [boolean, string, (run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    fn().catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
  };
  return [busy, error, run];
}

/** B 站凭据的配置状态；本地声音由宿主报告，不依赖云端语音密钥。 */
let secretVersion = 0;
const secretListeners = new Set<() => void>();
function bumpSecrets(): void {
  secretVersion += 1;
  for (const l of secretListeners) l();
}

function useSecrets(): Record<string, boolean | null> {
  const creds = useCredentials();
  const version = useSyncExternalStore((l) => { secretListeners.add(l); return () => secretListeners.delete(l); }, () => secretVersion);
  const [state, setState] = useState<Record<string, boolean | null>>({ cookie: null });
  useEffect(() => {
    if (!creds) return;
    const refs = [SECRET_REFS.cookie];
    void creds.describe(refs).then((r) => setState({ cookie: !!r.value?.[SECRET_REFS.cookie]?.configured })).catch(() => {});
  }, [creds, version]);
  return state;
}

function SecretField({ label, ref_, hint, configured }: { label: string; ref_: string; hint: string; configured: boolean | null }) {
  const [value, setValue] = useState('');
  const [busy, error, run] = useBusy();
  const creds = useCredentials();
  if (!creds) return <div className="dl-field"><label>{label}</label><p className="dl-hint">这个 DSH 没有凭据服务：用环境变量 {ref_} 提供。</p></div>;
  return (
    <div className="dl-field">
      <label>{label} {configured === null ? null : configured ? <span className="dl-tag dl-ok-tag">已配置</span> : <span className="dl-tag">未配置</span>}</label>
      <div className="dl-row">
        <input type="password" value={value} placeholder={configured ? '已保存（重新填写会覆盖）' : hint} onChange={(e) => setValue(e.target.value)} />
        <button disabled={busy || !value.trim()} onClick={() => run(async () => {
          await creds.set(ref_, value.trim());
          setValue('');
          bumpSecrets();
        })}>保存</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

/** 舞台服务器上的文件（角色插画、模板预览图）：控制台用 OBS 地址里的 token 去取 */
function stageFile(stageUrl: string | undefined, kind: 'characters' | 'templates', id: string, file: string): string {
  if (!stageUrl) return '';
  const url = new URL(stageUrl);
  return `${url.origin}/${kind}/${id}/${encodeURIComponent(file)}?token=${url.searchParams.get('token') ?? ''}`;
}

function Img({ src, className, fallback = null }: { src: string; className: string; fallback?: React.ReactNode }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) return <>{fallback}</>;
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

// ── 控制台 ────────────────────────────────────────────

export function Console() {
  const svc = useServices();
  const { status, feed, focus, brainDetail, broadcast: liveBc, transportError, transportConnected } = useLive();
  const [host, setHost] = useState<HostState | null>(null);
  // External publication is the safe default; OBS starts only when selected.
  const publisher = host?.publisher ?? host?.settings.publisher ?? 'livehime';
  const [busy, error, run] = useBusy();
  const [loadError, setLoadError] = useState('');
  const [room, setRoom] = useState('');
  const [copied, setCopied] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [dock, setDock] = useState<'owner' | 'sim'>('owner');
  const previewRef = useRef<HTMLDivElement>(null);
  const secrets = useSecrets();

  const refresh = () => api('state').then((s) => { setLoadError(''); setHost(s); setRoom((r) => r || (s.settings.roomId ? String(s.settings.roomId) : '')); });
  useEffect(() => {
    let active = true;
    void refresh().catch(error => { if (active) setLoadError(error instanceof Error ? error.message : '直播状态读取失败'); });
    return () => { active = false; };
  }, [transportConnected]);

  const show = status ?? host?.show ?? null;
  const settings = host?.settings;

  const goLive = () => run(async () => {
    if (!svc) throw new Error('插件还没准备好，刷新一下页面再试。');
    // 推流到 B 站：先开播拿推流码、OBS 推上流（可能要扫码人脸认证），推上了她再开口
    if (publisher === 'obs' && settings?.broadcast) {
      await api('broadcast/start', {});
      await waitBroadcast();
    }
    // The Host owns the fixed Elysia session and its existing standing prompts.
    await api('onair', {});
    await refresh();
  });

  const endLive = () => run(async () => { await api('offair', {}); await refresh(); });

  const saveRoom = () => run(async () => {
    setHost(await api('settings', { roomId: Number(room) }));
    setHost(await api('connect', {}));
  });

  const choose = (patch: Record<string, unknown>) => run(async () => setHost(await api('settings', patch)));
  // 换了主题：预览重新打开、演示一遍开场动画和直播中的样子（直播中不演示，直接换）
  const [demo, setDemo] = useState(0);
  const chooseTheme = (id: string) => run(async () => {
    setHost(await api('settings', { template: id }));
    if (!(status ?? host?.show)?.onAir) setDemo((n) => n + 1);
  });

  const copyUrl = () => {
    if (!host) return;
    void navigator.clipboard.writeText(host.stageUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const bc = liveBc ?? host?.broadcast ?? null;
  const conn = show?.live.state ?? 'idle';
  const connTone = conn === 'connected' ? 'ok' : conn === 'error' ? 'bad' : conn === 'idle' ? 'idle' : 'warn';
  const previewUrl = host ? `${host.stageUrl}&preview=1${demo ? `&demo=${demo}` : ''}` : '';
  const brainTone = !show?.onAir ? 'idle' : show.brain === 'away' ? 'bad' : show.brain === 'speaking' ? 'warn' : 'ok';
  const brainText = show?.onAir ? (show.brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[show.brain]) : '没在播';
  const pending = show ? (show.pending.chats ?? 0) + (show.pending.gifts ?? 0) + (show.pending.thanks ?? 0) + (show.pending.superchats ?? 0) : 0;
  const character = settings?.character ?? '';

  // 开播前准备：缺什么一眼看到，点一下打开设置
  const steps = [
    { key: 'tts', done: host?.voice?.available === true, text: '本地 Breeze 声音', hint: host?.voice?.error || (host?.voice?.available ? '已配置，播放结果以舞台回执为准' : '等待宿主报告配置状态') },
    { key: 'obs', done: !!show?.stageWatchers, text: publisher === 'livehime' ? '直播姬接入舞台' : 'OBS 打开舞台', hint: publisher === 'livehime' ? '复制舞台地址，添加浏览器源并启用声音' : '复制下面的舞台地址' },
    { key: 'room', done: conn === 'connected', text: '连上直播间', hint: '不连也能用模拟观众彩排' },
    { key: 'cookie', done: show?.live.loggedIn === true || secrets.cookie === true, text: 'B 站 Cookie', hint: '看到观众的完整名字' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className={`dl-room${show?.onAir ? ' dl-live' : ''}`}>
      <div className="dl-page">
        <header className="dl-top">
          <div className="dl-brand">
            <span className="dl-avatar">
              <Img className="dl-avatar-img" src={stageFile(host?.stageUrl, 'characters', character, 'art/portrait.webp')} fallback={<BroadcastGlyph />} />
            </span>
            <div className="dl-brand-text">
              <h1>爱莉直播{show?.onAir ? <span className="dl-onair"><i />LIVE</span> : <span className="dl-offair">未开播</span>}</h1>
              <div className="dl-pills">
                <span className="dl-pill"><Dot tone={brainTone} />{brainText}</span>
                <span className="dl-pill"><Dot tone={connTone} />直播间{CONN_TEXT[conn] ?? conn}{show?.live.room?.title ? ` · ${show.live.room.title}` : ''}</span>
                <span className="dl-pill"><Dot tone={show?.stageWatchers ? 'ok' : 'idle'} />{show?.stageWatchers ? (publisher === 'livehime' ? `舞台浏览器源已连接 ${show.stageWatchers} 个` : `OBS 已连上 ${show.stageWatchers} 个`) : (publisher === 'livehime' ? '直播姬还未接入舞台' : 'OBS 还没打开舞台')}</span>
                {bc && bc.phase !== 'idle' && <BroadcastPill bc={bc} />}
              </div>
            </div>
          </div>
          <div className="dl-top-actions">
            <button className="dl-icon-btn" title="设置" onClick={() => setDrawer(true)}><GearGlyph /><span>设置</span></button>
            {!show?.onAir && (
              <button className={`dl-switch${settings?.broadcast ? ' dl-on' : ''}`} disabled={busy} title={publisher === 'livehime' ? '由直播姬负责画面、音频和推流；这里只控制爱莉的直播回应' : '关着：只在本地彩排（OBS 不推流）；开着：开播时真的推流到 B 站'} onClick={() => publisher === 'obs' && choose({ broadcast: !settings?.broadcast })}>
                <i /><span>{publisher === 'livehime' ? '直播姬推流' : settings?.broadcast ? '推流到 B 站' : '本地彩排'}</span>
              </button>
            )}
            {show?.onAir
              ? <button className="dl-btn dl-danger" disabled={busy} onClick={endLive}>下播（先让她道别）</button>
              : <button className="dl-btn dl-primary" disabled={busy || bc?.phase === 'preparing' || bc?.phase === 'face'} onClick={goLive}><i className="dl-go-dot" />{publisher === 'livehime' ? '开始直播回应' : settings?.broadcast ? '开播' : '开始彩排'}</button>}
          </div>
        </header>
        {(error || loadError || transportError) && <p className="dl-error dl-banner" role="alert">{error || loadError || transportError}</p>}
        {bc?.phase === 'error' && bc.error && error !== bc.error && <p className="dl-error dl-banner">{bc.error}</p>}
        {bc?.phase === 'face' && bc.faceQr && <FaceModal qr={bc.faceQr} onCancel={() => run(async () => { await api('broadcast/stop', {}); await refresh(); })} />}

        {!show?.onAir && doneCount < steps.length && (
          <div className="dl-checklist">
            <b>开播前准备 <em>{doneCount}/{steps.length}</em></b>
            {steps.map((s) => (
              <button key={s.key} className={s.done ? 'dl-step dl-step-done' : 'dl-step'} onClick={() => { if (s.key === 'obs') copyUrl(); else setDrawer(true); }}>
                <i>{s.done ? '✓' : ''}</i><span>{s.text}</span><small>{s.hint}</small>
              </button>
            ))}
          </div>
        )}

        <div className="dl-grid">
          <main className="dl-main">
            <section className="dl-monitor">
              <div className="dl-preview" ref={previewRef}>
                {previewUrl && <iframe src={previewUrl} title="舞台预览" />}
                <button className="dl-fullscreen" title="全屏看舞台（Esc 退出）" onClick={() => void previewRef.current?.requestFullscreen?.()}><FullscreenGlyph /><span>全屏</span></button>
                <span className={`dl-preview-tag${show?.onAir ? ' dl-preview-live' : ''}`}><i />{publisher === 'livehime' ? (show?.onAir ? '回应中 · 舞台预览（此处静音）' : '预览：直播姬舞台源将显示「马上开始」的等待画面') : (show?.onAir ? '直播中 · 和 OBS 里一样（静音）' : '预览：开播后的样子 · OBS 里现在是「马上开始」的等待画面')}</span>
              </div>
              <div className="dl-monitor-bar">
                <div className="dl-obs">
                  <span className="dl-label">{publisher === 'livehime' ? '直播姬浏览器源' : 'OBS 浏览器源'}</span>
                  <code onClick={copyUrl} title="点一下复制">{host?.stageUrl ?? ''}</code>
                  <button className={copied ? 'dl-done' : ''} onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
                  <span className="dl-meta">1920 × 1080</span>
                </div>
              </div>
              <div className="dl-skins">
                <span className="dl-label">主题</span>
                <div className="dl-skin-list">
                  {host && [...host.templates].sort((a, b) => Number(b.id === 'default') - Number(a.id === 'default')).map((t) => (
                    <button key={t.id} className={`dl-skin${t.id === settings?.template ? ' dl-on' : ''}`} onClick={() => chooseTheme(t.id)}>
                      <Img className="dl-skin-img" src={stageFile(host.stageUrl, 'templates', t.id, 'preview.jpg')} fallback={<span className="dl-skin-img dl-skin-blank" />} />
                      <b>{t.name}</b>{t.builtin ? null : <small>自定义</small>}
                    </button>
                  ))}
                </div>
                {host && host.characters.length > 1 && (
                  <>
                    <span className="dl-label">角色</span>
                    <div className="dl-chips">
                      {host.characters.map((c) => <button key={c.id} className={c.id === settings?.character ? 'dl-on' : ''} onClick={() => choose({ character: c.id })}>{c.name}</button>)}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="dl-dock">
              <nav className="dl-tabs">
                <button className={dock === 'owner' ? 'dl-on' : ''} onClick={() => setDock('owner')}>跟她说话</button>
                <button className={dock === 'sim' ? 'dl-on' : ''} onClick={() => setDock('sim')}>模拟观众</button>
                <span className="dl-meta">{dock === 'owner' ? '观众也会听到她的回答' : '不开直播间也能彩排'}</span>
              </nav>
              {dock === 'owner' ? <OwnerSay onAir={!!show?.onAir} /> : <Simulator />}
            </section>
          </main>

          <aside className="dl-side">
            <div className="dl-side-head">
              <div className="dl-now"><Dot tone={brainTone} /><b>{brainText}</b></div>
              <div className="dl-stats">
                <div><b>{show?.live.stats.online ?? '–'}</b><span>在线</span></div>
                <div><b>{show?.live.perMinute.chat ?? 0}</b><span>弹幕/分</span></div>
                <div><b>{show ? { unknown: '未估计', quiet: '冷清', normal: '一般', busy: '热闹' }[show.heat] ?? '未知' : '–'}</b><span>热度</span></div>
                <div className={pending ? 'dl-hot' : ''}><b>{pending}</b><span>待回应</span></div>
              </div>
            </div>
            <Feed feed={feed} focus={focus} sleep={stageFile(host?.stageUrl, 'characters', character, 'art/sleep.webp')} />
            {show?.brainSession && (
              <div className="dl-links">
                <button className="dl-link" onClick={() => svc?.uiWorkspace.openSession(show.brainSession!)}>打开她直播的会话 →</button>
                {show.onAir && <button className="dl-link" onClick={() => svc && void cancel(svc, show.brainSession!)}>让她停下这一轮</button>}
              </div>
            )}
          </aside>
        </div>
      </div>

      {drawer && (
        <div className="dl-drawer-wrap" onClick={() => setDrawer(false)}>
          <aside className="dl-drawer" onClick={(e) => e.stopPropagation()}>
            <header><h2>设置</h2><button className="dl-icon-btn" onClick={() => setDrawer(false)}>关闭</button></header>
            <h3>直播间</h3>
            <div className="dl-field">
              <label>B 站直播间房间号</label>
              <div className="dl-row">
                <input value={room} inputMode="numeric" placeholder="直播间网址最后那串数字" onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))} />
                {conn === 'idle' || conn === 'error'
                  ? <button disabled={busy || !room} onClick={saveRoom}>连接</button>
                  : <button disabled={busy} onClick={() => run(async () => setHost(await api('disconnect', {})))}>断开</button>}
              </div>
              {settings?.roomId ? (
                <label className="dl-check"><input type="checkbox" checked={settings.ownRooms.includes(settings.roomId)} onChange={(e) => choose({ ownRoom: e.target.checked })} /> 这是我自己的直播间（用于明确直播间归属）</label>
              ) : null}
              {show?.live.state === 'connected' && !show.live.loggedIn && <p className="dl-hint">匿名连接：部分观众的名字会被 B 站打码。填上 Cookie 就能看到完整名字。</p>}
              {show?.live.lastError && <p className="dl-error">{show.live.lastError}</p>}
            </div>
            <h3>{publisher === 'livehime' ? '直播姬发布' : '推流到 B 站'}</h3>
            {publisher === 'livehime' && <p className="dl-hint">当前由直播姬负责画面、音频与发布。将舞台地址添加为浏览器源并启用声音；「开始直播回应」只控制爱莉的回应。开播与下播请在直播姬中操作。</p>}
            {publisher === 'obs' && <>
            <ObsCheck />
            <div className="dl-field">
              <label>直播标题（开播前改成这个；空着就用 B 站上现在的）</label>
              <input defaultValue={settings?.liveTitle ?? ''} maxLength={40} placeholder="比如：今晚和爱莉聊聊天" onBlur={(e) => choose({ liveTitle: e.target.value })} />
            </div>
            <div className="dl-field">
              <label>直播分区 id（子分区；空着就用 B 站给这个账号准备的默认分区）</label>
              <input defaultValue={settings?.areaId ?? ''} inputMode="numeric" placeholder="比如 371（虚拟日常）" onBlur={(e) => { const digits = e.target.value.replace(/\D/g, ''); choose({ areaId: digits ? Number(digits) : null }); }} />
              <div className="dl-row">
                <select value={settings?.pushProtocol ?? 'srt'} onChange={(e) => choose({ pushProtocol: e.target.value })}>
                  <option value="srt">SRT（推荐：跨境、Wi-Fi 更稳）</option>
                  <option value="rtmp">RTMP</option>
                </select>
                <input defaultValue={settings?.streamKbps ?? 4500} inputMode="numeric" title="码率 kbps" onBlur={(e) => choose({ streamKbps: Number(e.target.value.replace(/\D/g, '')) || 4500 })} />
                <span className="dl-meta">kbps</span>
              </div>
              <p className="dl-hint">开播时：没有直播间会自动开通；B 站要人脸认证时这里弹出二维码，用 B 站 App 扫一下；推流码自动填进 OBS（专用配置「dsh-livestream」，1080p30、NVENC、CBR，RTMP 网络堵时自动降码率），不用手动配 OBS。推流时上面会显示码率和丢帧，丢帧多就换 SRT 或调低码率。</p>
            </div>
            </>}
            <h3>告示板</h3>
            <BoardField value={settings?.boardText ?? ''} fallback={host?.defaultBoard ?? ''} onSave={(boardText) => choose({ boardText })} />
            <h3>滚动通知</h3>
            <div className="dl-field">
              <div className="dl-row">
                <input key={settings?.noticeText ?? ''} defaultValue={settings?.noticeText ?? ''} placeholder="比如：游戏画面卡住了，主人在修，马上回来" onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { if (e.target.value.trim() !== (settings?.noticeText ?? '')) choose({ noticeText: e.target.value }); }} />
                <button type="button" onClick={() => choose({ noticeText: '' })}>收起</button>
              </div>
              <p className="dl-hint">写了就在画面最底下滚动，告诉观众现在出了什么状况；回车生效，「收起」就不显示了。</p>
            </div>
            <h3>节奏</h3>
            <div className="dl-field">
              <div className="dl-row">
                <input defaultValue={settings?.idleAfterSec ?? 45} inputMode="numeric" title="空闲注意窗口（秒）" onBlur={(e) => choose({ idleAfterSec: Number(e.target.value.replace(/\D/g, '')) || 45 })} />
                <span className="dl-meta">秒：直播间达到窗口时，她可以选择回应或略过</span>
              </div>
              <div className="dl-row">
                <input defaultValue={settings?.gameChatGapSec ?? 15} inputMode="numeric" title="弹幕间隔（秒）" onBlur={(e) => choose({ gameChatGapSec: Number(e.target.value.replace(/\D/g, '')) || 15 })} />
                <span className="dl-meta">秒：玩游戏时弹幕至少隔这么久推给她一次</span>
              </div>
              <div className="dl-pace">
                {PACE_FIELDS.map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input key={String(settings?.pace?.[key] ?? '')} defaultValue={String(settings?.pace?.[key] ?? '')} placeholder="自动"
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(settings?.pace?.[key] ?? '')) choose({ pace: { [key]: key === 'welcomeSec' && /^(off|关)$/i.test(v) ? 'off' : v } as never }); }} />
                  </label>
                ))}
              </div>
              <p className="dl-hint">都是改了马上生效，不用重启。留空就按直播间热闹程度自动（人少时回得勤、人多时攒一攒）；现场不合适就直接填：间隔填秒数，「欢迎」填 off 就不欢迎新进来的观众。大礼物、醒目留言、上舰不受这些间隔限制。</p>
            </div>
            <h3>黑名单</h3>
            <div className="dl-field">
              <textarea key={blockedText(settings?.blocked)} defaultValue={blockedText(settings?.blocked)} rows={3} placeholder="一行一位：UID 名字 原因"
                onBlur={(e) => { if (e.target.value.trim() !== blockedText(settings?.blocked)) choose({ blocked: parseBlocked(e.target.value, settings?.blocked ?? []) }); }} />
              <p className="dl-hint">一行一位：UID、名字、原因，空格隔开。名单上的人进直播间、发弹幕、送礼物她都看不到，不欢迎、不回、不记、不私信；改了马上生效。</p>
            </div>
            <h3>看视频</h3>
            <div className="dl-field">
              <label>语音识别用的 Python {host?.asr.available ? <span className="dl-tag dl-ok-tag">能用</span> : <span className="dl-tag">没配好</span>}</label>
              <input defaultValue={settings?.asrPython ?? ''} placeholder="装了 faster-whisper 的 python.exe 的完整路径" onBlur={(e) => choose({ asrPython: e.target.value })} />
              <div className="dl-row">
                <input defaultValue={settings?.asrModel ?? 'large-v3-turbo'} title="whisper 模型" onBlur={(e) => choose({ asrModel: e.target.value })} />
                <span className="dl-meta">模型：有 N 卡用 large-v3-turbo，只有 CPU 用 small</span>
              </div>
              <p className="dl-hint">她看的 B 站视频没有字幕时，用本机的 faster-whisper 听一段（5 分钟一段，显卡上几秒）写成字幕给她看。不填就只告诉她「没有字幕」。装法：<code>python -m venv asr-venv</code>，再 <code>asr-venv\Scripts\python -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12</code>（没有 N 卡只装 faster-whisper）。模型第一次用时自动下载（约 1.6 GB，走 hf-mirror 镜像）。</p>
            </div>
            <h3>密钥</h3>
            <div className="dl-field"><label>本地 Breeze 声音</label><p className="dl-hint">{host?.voice?.label || '沿用本机爱莉声音'} · {host?.voice?.available ? '已配置，播放结果以舞台回执为准' : (host?.voice?.error || '配置状态未知')}</p></div>
            <LoginField />
            <SecretField label="B 站 Cookie（不想扫码时手填）" ref_={SECRET_REFS.cookie} configured={secrets.cookie} hint="浏览器里登录 B 站后复制的 Cookie；扫码登录会自动填这一项" />
            <h3>舞台</h3>
            <div className="dl-field">
              <label>{publisher === 'livehime' ? '直播姬浏览器源地址（启用声音；宽 1920 高 1080）' : 'OBS 舞台地址（来源 → 浏览器 → 粘贴，宽 1920 高 1080）'}</label>
              <div className="dl-row">
                <input readOnly value={host?.stageUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                <button className={copied ? 'dl-done' : ''} onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
              </div>
              <p className="dl-hint">想做自己的主题：把插件里 assets/templates/default 复制到 DSH 主目录的 dsh-livestream/templates/&lt;新名字&gt;/，改 template.json 的 id 和 name。</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** 等推流准备好：推上了返回；出错、取消就抛出（人脸认证最多等 5 分钟，宿主那边会超时） */
async function waitBroadcast(): Promise<void> {
  const deadline = Date.now() + 7 * 60_000;
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() < deadline) {
    const bc = live.broadcast;
    if (bc?.phase === 'streaming') return;
    if (bc?.phase === 'error') throw new Error(bc.error ?? '推流失败');
    if (bc?.phase === 'idle' || bc?.phase === 'stopping') throw new Error('推流取消了');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等推流等太久了');
}

const PHASE_TEXT = { idle: '', preparing: '准备推流', face: '等人脸认证', streaming: '推流中', stopping: '正在下播', error: '推流出错' } as const;

function BroadcastPill({ bc }: { bc: BroadcastStatus }) {
  const tone = bc.phase === 'streaming' ? 'ok' : bc.phase === 'error' ? 'bad' : 'warn';
  const h = bc.health;
  const dropped = h && h.total ? ((h.skipped / h.total) * 100).toFixed(1) : null;
  return (
    <span className="dl-pill" title={bc.step}>
      <Dot tone={tone} />B 站 · {bc.phase === 'streaming' && h ? `${h.kbps} kbps · 丢帧 ${dropped ?? 0}% · ${h.timecode.slice(0, 8)}` : bc.step || PHASE_TEXT[bc.phase]}
    </span>
  );
}

/** 开播账号：现在登的是谁；扫码登录（B 站 App 扫一下，Cookie 由插件自己存进凭据） */
function LoginField() {
  const [account, setAccount] = useState<{ uid: number; name: string } | null | undefined>(undefined);
  const [qr, setQr] = useState<{ img: string; key: string } | null>(null);
  const [status, setStatus] = useState('');
  const refresh = () => void api<{ ok: boolean; account: { uid: number; name: string } | null }>('account').then((r) => setAccount(r.account)).catch(() => setAccount(null));
  useEffect(refresh, []);
  useEffect(() => {
    if (!qr) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await api<{ ok: boolean; state: string; message?: string; account?: { uid: number; name: string } }>('login/poll', { key: qr.key });
        if (r.state === 'ok') { setQr(null); setStatus(''); setAccount(r.account ?? null); return; }
        if (r.state === 'expired') { setQr(null); setStatus('二维码过期了，再点一次扫码登录'); return; }
        if (r.state === 'error') { setQr(null); setStatus(r.message ?? '登录失败'); return; }
        setStatus(r.state === 'scanned' ? '扫好了，在 App 上点确认登录' : '用 B 站 App 扫这个码（开播用的那个账号）');
      } catch (err) {
        setStatus((err as Error).message);
      }
      setTimeout(tick, 2000);
    };
    void tick();
    return () => { stopped = true; };
  }, [qr?.key]);
  const start = async () => {
    setStatus('');
    try {
      const r = await api<{ ok: boolean; url: string; key: string }>('login/start', {});
      setQr({ img: await QRCode.toDataURL(r.url, { margin: 1, width: 200 }), key: r.key });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <div className="dl-field">
      <label>开播账号 {account ? <span className="dl-tag dl-ok-tag">已登录</span> : account === null ? <span className="dl-tag">没登录</span> : null}</label>
      <div className="dl-row">
        <span className="dl-meta" style={{ flex: 1 }}>{account ? `${account.name}（UID ${account.uid}）` : account === null ? '开播、私信、评论都要先登录' : '查询中…'}</span>
        <button onClick={() => void start()}>{account ? '换个账号' : '扫码登录'}</button>
      </div>
      {qr && <img src={qr.img} alt="B 站登录二维码" style={{ width: 200, height: 200, borderRadius: 12, marginTop: 8, background: '#fff' }} />}
      {status && <p className="dl-hint">{status}</p>}
    </div>
  );
}

/** 告示板：主人想让观众知道的。改完离开输入框就换到舞台上 */
interface BlockedViewer { uid: string; name: string; why: string; at: number }

function blockedText(list: BlockedViewer[] | undefined): string {
  return (list ?? []).map((b) => [b.uid, b.name, b.why].filter(Boolean).join(' ')).join('\n');
}

/** 「UID 名字 原因」一行一位；原来就在名单上的保留拉黑时间 */
function parseBlocked(text: string, before: BlockedViewer[]): BlockedViewer[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [uid = '', name = '', ...why] = line.split(/\s+/);
    return { uid, name, why: why.join(' '), at: before.find((b) => b.uid === uid)?.at ?? Date.now() };
  });
}

/** 节奏里主人可以改的几项（秒；一次回几位是人数） */
const PACE_FIELDS = [['welcomeSec', '欢迎新观众间隔'], ['thanksSec', '谢小礼物间隔'], ['followSec', '谢关注间隔'], ['chatPicks', '一次回几位']] as const;

function BoardField({ value, fallback, onSave }: { value: string; fallback: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="dl-field">
      <label>直播画面上的告示板（空行分页，每页第一行是标题；清空就不显示）</label>
      <textarea value={text} rows={10} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />
      <div className="dl-row">
        <button disabled={text === fallback} onClick={() => { setText(fallback); onSave(fallback); }}>恢复默认</button>
        <span className="dl-meta">几页轮着放；开播时她也会知道上面写了什么</span>
      </div>
    </div>
  );
}

/** 检查 OBS：打开 OBS、设好专用配置和场景，看一帧节目画面（不推流） */
function ObsCheck() {
  const [busy, error, run] = useBusy();
  const [result, setResult] = useState<{ image: string; profile: string; collection: string } | null>(null);
  return (
    <div className="dl-field">
      <div className="dl-row">
        <button disabled={busy} onClick={() => run(async () => setResult(await api<{ ok: boolean; image: string; profile: string; collection: string }>('obs/check', {})))}>{busy ? '正在打开 OBS…' : '检查 OBS'}</button>
        <span className="dl-meta">打开 OBS、设好画质和舞台，看一帧画面；不推流</span>
      </div>
      {error && <p className="dl-error">{error}</p>}
      {result && (
        <>
          <img src={result.image} alt="OBS 节目画面" style={{ width: '100%', borderRadius: 10, marginTop: 8 }} />
          <p className="dl-hint">OBS 配置「{result.profile}」· 场景集合「{result.collection}」</p>
        </>
      )}
    </div>
  );
}

/** 人脸认证：用开播账号的 B 站 App 扫这个码 */
function FaceModal({ qr, onCancel }: { qr: string; onCancel: () => void }) {
  const [img, setImg] = useState('');
  useEffect(() => { void QRCode.toDataURL(qr, { margin: 1, width: 240 }).then(setImg).catch(() => setImg('')); }, [qr]);
  return (
    <div className="dl-modal-wrap">
      <div className="dl-modal">
        <h2>B 站要人脸认证</h2>
        <p>用<b>开播账号</b>登录的 B 站 App 扫这个码，按提示刷脸。认证通过后会自动开播，不用再点。</p>
        {img ? <img className="dl-qr" src={img} alt="人脸认证二维码" /> : <code className="dl-qr-text">{qr}</code>}
        <button className="dl-link" onClick={onCancel}>不开了</button>
      </div>
    </div>
  );
}

function OwnerSay({ onAir }: { onAir: boolean }) {
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = () => run(async () => {
    if (!text.trim()) return;
    await api('owner', { text });
    setText('');
  });
  return (
    <div className="dl-dock-body">
      <div className="dl-row">
        <input value={text} placeholder={onAir ? '比如：给大家讲讲你今天学到的东西' : '开播以后才能跟她说话'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="dl-send" disabled={busy || !onAir || !text.trim()} onClick={send}>说</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

function BroadcastGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.2 18.8a9.6 9.6 0 0 1 0-13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
    </svg>
  );
}

function FullscreenGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

/** 醒目留言按金额分档（和舞台一样的 B 站配色） */
function scTier(yuan: number): string {
  if (yuan >= 2000) return 'red';
  if (yuan >= 1000) return 'orange';
  if (yuan >= 500) return 'pink';
  if (yuan >= 100) return 'yellow';
  if (yuan >= 50) return 'cyan';
  return 'blue';
}

/** 头像底色按名字换 */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Feed({ feed, focus, sleep }: { feed: FeedRow[]; focus: Set<string>; sleep: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => feed.filter((r) => r.kind !== 'enter').slice(-80), [feed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [rows.length]);
  if (!rows.length) {
    return (
      <div className="dl-feed dl-feed-empty">
        <Img className="dl-empty-art" src={sleep} />
        <p>还没有动静。连上直播间，或者在「模拟观众」里发一条试试。</p>
      </div>
    );
  }
  return (
    <div className="dl-feed" ref={ref}>
      {rows.map((r) => {
        const focused = !!r.uid && focus.has(r.uid);
        return (
          <div key={r.key} className={`dl-feed-row dl-k-${r.kind}${focused ? ' dl-focus' : ''}${r.kind === 'superchat' && r.yuan ? ` dl-sc-${scTier(r.yuan)}` : ''}`}>
            {r.kind === 'her'
              ? <span className="dl-feed-avatar dl-her-avatar">鲸</span>
              : <span className="dl-feed-avatar" style={{ '--h': hue(r.name) } as React.CSSProperties}>{[...r.name][0] ?? '?'}</span>}
            <div className="dl-feed-main">
              <span className="dl-feed-name">{r.kind === 'her' ? '她' : r.name}{focused && <em>她在回</em>}{r.yuan ? <b>¥{r.yuan}</b> : null}</span>
              <span className="dl-feed-text">{r.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Simulator() {
  const [name, setName] = useState('测试观众');
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = (kind: string, extra: Record<string, unknown> = {}) => run(() => api('simulate', { kind, name, text, ...extra }).then(() => { if (kind === 'chat' || kind === 'superchat') setText(''); }));
  return (
    <div className="dl-dock-body">
      <div className="dl-row">
        <input className="dl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="观众名" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="弹幕内容（醒目留言也用这里的字）" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send('chat'); }} />
        <button className="dl-send" disabled={busy || !text.trim()} onClick={() => send('chat')}>发弹幕</button>
      </div>
      <div className="dl-sim">
        <span>礼物</span>
        <div className="dl-chips">
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '小花花', count: 5, yuan: 0.5 })}>小花花 ×5</button>
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '情书', count: 1, yuan: 5.2 })}>情书 ¥5.2</button>
          <button className="dl-chip-gift dl-chip-big" onClick={() => send('gift', { gift: '小电视飞船', count: 1, yuan: 1245 })}>小电视飞船 ¥1245</button>
        </div>
        <span>醒目留言</span>
        <div className="dl-chips">
          {[30, 100, 500, 2000].map((yuan) => (
            <button key={yuan} className={`dl-chip-sc dl-sc-${scTier(yuan)}`} disabled={!text.trim()} title={text.trim() ? '' : '先在上面写留言内容'} onClick={() => send('superchat', { yuan })}>¥{yuan}</button>
          ))}
        </div>
        <span>其他</span>
        <div className="dl-chips">
          <button onClick={() => send('enter')}>进场</button>
          <button onClick={() => send('follow')}>关注</button>
          <button className="dl-chip-guard" onClick={() => send('membership', { guard: 3 })}>上舰</button>
        </div>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

export const CONSOLE_CSS = `
.dl-switch{display:inline-flex;align-items:center;gap:8px;padding:9px 14px !important;border-radius:999px !important;font-size:13px}
.dl-switch i{width:30px;height:17px;border-radius:999px;background:rgba(120,130,150,.35);position:relative;transition:background .2s}
.dl-switch i::after{content:'';position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dl-switch.dl-on i{background:#ff5d7a}
.dl-switch.dl-on i::after{transform:translateX(13px)}
.dl-switch.dl-on span{color:#ff5d7a;font-weight:600}
.dl-modal-wrap{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(10,14,30,.45);backdrop-filter:blur(6px)}
.dl-modal{width:min(380px,90vw);padding:26px 28px;border-radius:22px;text-align:center;background:#fff;color:#1d2433;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
.dl-modal h2{margin:0 0 8px;font-size:18px}
.dl-modal p{margin:0 0 16px;font-size:13px;line-height:1.7;color:#5b6475}
.dl-qr{width:240px;height:240px;border-radius:12px;background:#fff;padding:8px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.dl-qr-text{display:block;word-break:break-all;font-size:11px;margin-bottom:12px}
/* 颜色跟着 DSH 的亮色 / 暗色走：底色、文字、边框用 DSH 的主题变量，自己只管强调色（light-dark 按 DSH 设在页面上的 color-scheme 取值） */
.dl-room{--dl-blue:#3fa3ff;--dl-pink:#ff7fa8;--dl-gold:light-dark(#c98200,#ffc65c);
  --dl-bg:light-dark(#f4f7fb,var(--dsw-alias-bg-base,#0f131e));
  --dl-surface:light-dark(#ffffff,var(--dsw-alias-bg-layer-1,#161b29));
  --dl-surface-2:light-dark(#eef3fa,var(--dsw-alias-bg-layer-3,#1c2233));
  --dl-sunken:light-dark(#f4f7fb,var(--dsw-alias-bg-base,#0f131e));
  --dl-hover:light-dark(#e2eaf6,#252c41);
  --dl-text:var(--dsw-alias-label-primary,light-dark(#1d2433,#e9eefb));
  --dl-dim:var(--dsw-alias-label-secondary,light-dark(#55607a,rgba(225,232,250,.64)));
  --dl-faint:var(--dsw-alias-label-caption,light-dark(#8a93a8,rgba(225,232,250,.4)));
  --dl-line:var(--dsw-alias-border-l2,light-dark(rgba(0,0,0,.1),rgba(255,255,255,.08)));
  --dl-shadow:0 10px 30px -18px light-dark(rgba(40,70,130,.35),rgba(0,0,0,.6));
  --dl-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  position:relative;height:100%;overflow:hidden;color:var(--dl-text);background:var(--dl-bg);
  background-image:radial-gradient(900px 380px at 70% -120px,light-dark(rgba(63,163,255,.12),rgba(92,182,255,.14)),transparent 70%),radial-gradient(700px 320px at 0% 0%,light-dark(rgba(255,127,168,.1),rgba(255,143,182,.08)),transparent 70%)}
.dl-page{height:100%;overflow:auto;padding:22px clamp(18px,3vw,40px) 32px;box-sizing:border-box;display:flex;flex-direction:column;gap:16px}

/* 顶栏：她是谁、现在怎样、开播 */
.dl-top{display:flex;align-items:center;justify-content:space-between;gap:20px}
.dl-brand{display:flex;align-items:center;gap:16px;min-width:0}
.dl-avatar{position:relative;flex:none;display:grid;place-items:center;width:58px;height:58px;border-radius:50%;overflow:hidden;color:#eaf6ff;
  background:linear-gradient(135deg,#bfe3ff,#ffd3e3);box-shadow:0 0 0 3px var(--dl-bg),0 0 0 5px rgba(63,163,255,.55)}
.dl-avatar-img{width:118%;height:118%;object-fit:cover;object-position:50% 12%}
.dl-live .dl-avatar{box-shadow:0 0 0 3px var(--dl-bg),0 0 0 5px #ff5c7c}
.dl-live .dl-avatar::after{content:'';position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 2px #ff5c7c;animation:dl-ping 1.8s ease-out infinite}
@keyframes dl-ping{to{transform:scale(1.35);opacity:0}}
.dl-top h1{display:flex;align-items:center;gap:12px;margin:0;font-size:22px;font-weight:750;letter-spacing:1px}
.dl-onair{display:inline-flex;align-items:center;gap:7px;font:700 12px var(--dl-mono);letter-spacing:2px;padding:4px 11px;border-radius:999px;color:#fff;background:#ff4d6d}
.dl-onair i{width:7px;height:7px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
@keyframes dl-rec{0%{box-shadow:0 0 0 0 rgba(255,255,255,.8)}100%{box-shadow:0 0 0 7px rgba(255,255,255,0)}}
.dl-offair{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;color:var(--dl-faint);background:var(--dl-surface-2)}
.dl-pills{display:flex;flex-wrap:wrap;gap:14px;margin-top:7px}
.dl-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dl-dim)}
.dl-top-actions{flex:none;display:flex;align-items:center;gap:10px}
.dl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dl-faint)}
.dl-ok{background:#5fe0a8}.dl-warn{background:#ffc65c;animation:dl-blink 1.2s ease-in-out infinite}.dl-bad{background:#ff7a8a}
@keyframes dl-blink{50%{opacity:.4}}

/* 按钮、输入框 */
.dl-room input,.dl-room select{flex:1;min-width:0;padding:10px 12px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-sunken);color:var(--dl-text);font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.dl-room textarea{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-sunken);color:var(--dl-text);font:13px/1.6 inherit;outline:none;resize:vertical}
.dl-pace{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:8px}
.dl-pace label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--dl-dim)}
.dl-pace input{width:64px;text-align:center}
.dl-room textarea:focus{border-color:rgba(63,163,255,.6);box-shadow:0 0 0 3px rgba(63,163,255,.14)}
.dl-room input:focus{border-color:rgba(63,163,255,.6);box-shadow:0 0 0 3px rgba(63,163,255,.14)}
.dl-room input.dl-name{flex:0 0 120px}
.dl-room button{padding:9px 14px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-surface-2);color:var(--dl-text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .2s,border-color .2s,transform .15s}
.dl-room button:hover:not(:disabled){background:var(--dl-hover);border-color:rgba(92,182,255,.4)}
.dl-room button:active:not(:disabled){transform:translateY(1px) scale(.98)}
.dl-room button:disabled{opacity:.4;cursor:default}
.dl-room button.dl-done{color:light-dark(#1f9e68,#5fe0a8);border-color:rgba(95,224,168,.5)}
.dl-room button.dl-send{min-width:64px;color:#fff;font-weight:700;background:var(--dl-blue);border-color:transparent}
.dl-room button.dl-send:hover:not(:disabled){background:#62b5ff}
.dl-room .dl-icon-btn{display:inline-flex;align-items:center;gap:7px;color:var(--dl-dim);background:transparent}
.dl-btn{display:inline-flex;align-items:center;gap:9px;font-size:15px !important;font-weight:750;letter-spacing:1px;padding:11px 26px !important;border-radius:999px !important}
.dl-room .dl-primary{color:#fff;background:linear-gradient(100deg,#ff6b8f,#ff8fb6);border-color:transparent;box-shadow:0 8px 24px -8px rgba(255,107,143,.8)}
.dl-room .dl-primary:hover:not(:disabled){background:linear-gradient(100deg,#ff7d9c,#ffa0c2);border-color:transparent}
.dl-go-dot{width:9px;height:9px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
.dl-room .dl-danger{color:light-dark(#d42d52,#ffd9e0);background:rgba(255,77,109,.14);border-color:rgba(255,120,140,.45)}

/* 开播前准备 */
.dl-checklist{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;border-radius:16px;background:linear-gradient(100deg,rgba(63,163,255,.1),rgba(255,127,168,.08));border:1px solid rgba(63,163,255,.2)}
.dl-checklist>b{font-size:13px;margin-right:6px}
.dl-checklist>b em{font-style:normal;color:var(--dl-blue);font-family:var(--dl-mono);margin-left:4px}
.dl-room button.dl-step{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;border-radius:999px;background:var(--dl-surface)}
.dl-step i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;font-style:normal;font-size:12px;border:1.5px dashed var(--dl-faint)}
.dl-step small{font-size:11px;color:var(--dl-faint)}
.dl-step-done{opacity:.7}
.dl-step-done i{border:0;background:#5fe0a8;color:#08261a;font-weight:800}

/* 主区：左边监视器 + 导播台，右边直播间 */
.dl-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:16px}
@media (max-width:1100px){.dl-grid{grid-template-columns:1fr}.dl-side{min-height:520px}}
.dl-main{display:flex;flex-direction:column;gap:16px;min-width:0}
.dl-label{font-size:12px;color:var(--dl-faint);letter-spacing:1px;white-space:nowrap}
.dl-meta{font-size:12px;color:var(--dl-faint)}

.dl-monitor{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow);overflow:hidden}
.dl-preview{position:relative;aspect-ratio:16/9;background:#05070c}
.dl-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dl-preview:fullscreen{aspect-ratio:auto;width:100vw;height:100vh;background:#000}
.dl-room .dl-fullscreen{position:absolute;right:12px;top:12px;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;
  color:#fff;background:rgba(10,14,24,.6);border-color:rgba(255,255,255,.18);backdrop-filter:blur(6px);opacity:.75}
.dl-room .dl-fullscreen:hover:not(:disabled){opacity:1;background:rgba(10,14,24,.8)}
.dl-preview:fullscreen .dl-fullscreen,.dl-preview:fullscreen .dl-preview-tag{display:none}
.dl-preview-tag{position:absolute;left:12px;top:12px;display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;color:#fff;background:rgba(10,14,24,.6);backdrop-filter:blur(6px);pointer-events:none}
.dl-preview-tag i{width:6px;height:6px;border-radius:50%;background:var(--dl-faint)}
.dl-preview-live i{background:#ff4d6d;animation:dl-rec 1.6s ease-out infinite}
.dl-monitor-bar{padding:12px 16px;border-top:1px solid var(--dl-line)}
.dl-obs{display:flex;align-items:center;gap:10px;min-width:0}
.dl-obs code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--dl-mono);color:var(--dl-dim);padding:8px 12px;border-radius:10px;background:var(--dl-sunken);cursor:pointer}
.dl-skins{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px 14px;padding:4px 16px 16px}
.dl-skin-list{display:flex;flex-wrap:wrap;gap:10px}
.dl-room button.dl-skin{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:6px 6px 8px;border-radius:14px;background:var(--dl-sunken)}
.dl-skin-img{display:block;width:150px;aspect-ratio:16/9;border-radius:9px;object-fit:cover}
.dl-skin-blank{background:linear-gradient(135deg,#2a3350,#3a2f4f)}
.dl-skin b{font-size:12px;font-weight:600;padding:0 4px}
.dl-skin small{font-size:10px;color:var(--dl-faint);padding:0 4px;margin-top:-4px}
.dl-room button.dl-skin.dl-on{border-color:var(--dl-blue);box-shadow:0 0 0 1px var(--dl-blue)}
.dl-skin.dl-on b{color:var(--dl-blue)}

.dl-dock{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow)}
.dl-tabs{display:flex;align-items:center;gap:4px;padding:10px 12px 0}
.dl-room .dl-tabs button{border:0;background:transparent;color:var(--dl-dim);font-weight:600;border-radius:10px 10px 0 0;padding:9px 14px}
.dl-room .dl-tabs button.dl-on{color:var(--dl-text);background:var(--dl-surface-2);box-shadow:inset 0 -2px 0 var(--dl-blue)}
.dl-tabs .dl-meta{margin-left:auto;padding-right:6px}
.dl-dock-body{padding:14px 16px 16px;border-top:1px solid var(--dl-line)}
.dl-row{display:flex;gap:10px;align-items:center}
.dl-sim{display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center;margin-top:14px}
.dl-sim>span{font-size:12px;color:var(--dl-faint)}
.dl-chips{display:flex;flex-wrap:wrap;gap:8px}
.dl-chips button{font-size:12px !important;padding:6px 13px !important;border-radius:999px !important}
.dl-room .dl-chips button.dl-on{border-color:var(--dl-blue);color:var(--dl-blue)}
.dl-room .dl-chips .dl-chip-gift{color:light-dark(#9a6200,#ffe1a6);border-color:rgba(255,190,80,.45);background:rgba(255,198,92,.1)}
.dl-room .dl-chips .dl-chip-big{color:#2a1b02;font-weight:700;border-color:transparent;background:linear-gradient(90deg,#ffe1a6,#ffb547)}
.dl-room .dl-chips .dl-chip-sc{color:#fff;font-weight:700;border-color:transparent;background:var(--sc)}
.dl-room .dl-chips .dl-chip-guard{color:#fff;border-color:transparent;background:linear-gradient(90deg,#3d8bff,#a58bff)}
.dl-sc-blue{--sc:#2a7bd8}.dl-sc-cyan{--sc:#19a8bd}.dl-sc-yellow{--sc:#d39a17}.dl-sc-pink{--sc:#e0609f}.dl-sc-orange{--sc:#ef7a2a}.dl-sc-red{--sc:#e0393f}

/* 右栏：直播间，像观众看到的弹幕栏 */
.dl-side{display:flex;flex-direction:column;min-height:0;border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);box-shadow:var(--dl-shadow);overflow:hidden}
.dl-side-head{padding:14px 16px 12px;border-bottom:1px solid var(--dl-line)}
.dl-now{display:flex;align-items:center;gap:9px;font-size:14px}
.dl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px}
.dl-stats div{padding:8px 4px;border-radius:12px;background:var(--dl-sunken);text-align:center}
.dl-stats b{display:block;font-size:17px;font-weight:750;font-family:var(--dl-mono)}
.dl-stats span{font-size:10px;color:var(--dl-faint)}
.dl-stats .dl-hot b{color:var(--dl-gold)}
.dl-feed{flex:1;min-height:260px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px 14px 10px}
.dl-feed::-webkit-scrollbar{width:6px}.dl-feed::-webkit-scrollbar-thumb{background:var(--dl-line);border-radius:3px}
.dl-feed-empty{align-items:center;justify-content:center;text-align:center}
.dl-feed-empty p{margin:0;font-size:12px;color:var(--dl-faint);max-width:220px;line-height:1.6}
.dl-empty-art{width:150px;opacity:.9}
.dl-feed-row{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;animation:dl-row-in .3s ease-out}
@keyframes dl-row-in{from{opacity:0;transform:translateY(6px)}}
.dl-feed-avatar{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:12px;font-weight:700;color:#fff;
  background:linear-gradient(135deg,hsl(var(--h,200) 70% 62%),hsl(calc(var(--h,200) + 40) 70% 55%))}
.dl-her-avatar{background:linear-gradient(135deg,var(--dl-blue),var(--dl-pink))}
.dl-feed-main{display:flex;flex-direction:column;align-items:flex-start;min-width:0;flex:1}
.dl-feed-name{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dl-faint);max-width:100%;white-space:nowrap;overflow:hidden}
.dl-feed-name em{font-style:normal;font-size:10px;font-weight:700;padding:0 7px;border-radius:999px;color:#fff;background:var(--dl-blue)}
.dl-feed-name b{color:var(--dl-gold);font-family:var(--dl-mono)}
.dl-feed-text{max-width:100%;box-sizing:border-box;padding:6px 11px;border-radius:4px 14px 14px 14px;background:var(--dl-surface-2);word-break:break-word}
.dl-k-her{flex-direction:row-reverse}
.dl-k-her .dl-feed-main{align-items:flex-end}
.dl-k-her .dl-feed-text{border-radius:14px 4px 14px 14px;color:#06121f;background:linear-gradient(120deg,#9fd5ff,#ffc4da)}
.dl-k-gift .dl-feed-text,.dl-k-membership .dl-feed-text{color:light-dark(#8a5800,#ffe1a6);background:rgba(255,198,92,.16)}
.dl-k-superchat .dl-feed-text{color:#fff;background:var(--sc,#2a7bd8)}
.dl-k-follow .dl-feed-text{color:light-dark(#c8457a,#ffc4da);background:rgba(255,143,182,.12)}
.dl-focus .dl-feed-text{box-shadow:0 0 0 2px var(--dl-blue)}
.dl-links{display:flex;gap:16px;padding:10px 16px 14px;border-top:1px solid var(--dl-line)}
.dl-room .dl-link{background:none;border:none;color:var(--dl-blue);padding:2px 0;font-size:12px}

/* 设置抽屉 */
.dl-drawer-wrap{position:absolute;inset:0;z-index:20;background:light-dark(rgba(30,40,60,.25),rgba(5,8,14,.5));backdrop-filter:blur(2px);animation:dl-fade .2s ease-out}
@keyframes dl-fade{from{opacity:0}}
.dl-drawer{position:absolute;top:0;right:0;bottom:0;width:min(440px,92%);overflow:auto;box-sizing:border-box;padding:20px 22px 30px;background:var(--dl-surface);border-left:1px solid var(--dl-line);box-shadow:-20px 0 50px -20px light-dark(rgba(40,60,100,.3),rgba(0,0,0,.6));animation:dl-slide .25s cubic-bezier(.2,.8,.2,1)}
@keyframes dl-slide{from{transform:translateX(40px);opacity:0}}
.dl-drawer>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dl-drawer h2{margin:0;font-size:17px}
.dl-drawer h3{margin:22px 0 4px;font-size:12px;font-weight:600;color:var(--dl-faint);letter-spacing:1px}
.dl-field{display:flex;flex-direction:column;gap:7px;margin-top:10px;min-width:0}
.dl-field label{font-size:12px;color:var(--dl-dim);display:flex;align-items:center;gap:8px}
.dl-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);margin:8px 0 2px}
.dl-check input{flex:none}
.dl-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dl-line);color:var(--dl-faint)}
.dl-ok-tag{color:light-dark(#1f9e68,#5fe0a8);border-color:rgba(95,224,168,.45)}
.dl-hint{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.6}
.dl-error{margin:6px 0 0;font-size:12px;color:light-dark(#d43a4f,#ffb4b4)}
.dl-banner{margin:0;padding:10px 14px;border-radius:12px;background:rgba(255,90,120,.1);border:1px solid rgba(255,120,140,.35)}
`;
