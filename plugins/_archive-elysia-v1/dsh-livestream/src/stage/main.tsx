/**
 * 舞台页：OBS 的浏览器源打开它（1920×1080 或模板写的尺寸）。按模板摆挂件、套主题变量、加载模板自己的 style.css。
 * 窗口和画布不一样大时整体缩放（控制台里的小预览也是这一页）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { arrange, type Mode, type Slot } from './layout';
import type { WidgetType } from './protocol';
import { assetUrl, connect, litChars, preview, sourceMode, startListening, stopListening, unlockAudio, type Line } from './store';
import { Effects } from './effects';
import { AiLabel, Alerts, Board, Character, Chat, Game, Notice, Orders, paginate, Reply, Rice, Scene, Status, Subtitle, SUBTITLE_LINGER_MS, Terminal, useLinger, useStage, Video } from './widgets';

const WIDGETS: Record<WidgetType, React.ComponentType<{ options?: Record<string, unknown> }>> = {
  character: Character,
  subtitle: Subtitle,
  chat: Chat,
  alerts: Alerts,
  status: Status,
  'ai-label': AiLabel,
  reply: Reply,
  rice: Rice,
  terminal: Terminal,
  scene: Scene,
  effects: Effects,
  video: Video,
  board: Board,
  game: Game,
  orders: Orders,
};

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** 两块摆的地方重叠了一半以上（小的那块为准） */
function overlaps(a: Slot, b: Slot): boolean {
  if (a.w === undefined || a.h === undefined || b.w === undefined || b.h === undefined) return false;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 && w * h > 0.5 * Math.min(a.w * a.h, b.w * b.h);
}

function Placed({ p, covered = false }: { p: Slot; covered?: boolean }) {
  const Widget = WIDGETS[p.type];
  if (!Widget) return null;
  return (
    <div
      className={`ls-slot ls-slot-${p.type}${p.hidden || covered ? ' ls-hidden' : ''}`}
      style={{ left: p.x, top: p.y, width: p.w, height: p.h, transform: p.scale && p.scale !== 1 ? `scale(${p.scale})` : undefined }}
    >
      <Widget options={p.options} />
    </div>
  );
}

/** 整块画布去掉一个矩形（evenodd：外框和洞各画一圈） */
function holePath(s: Slot, cw: number, ch: number): string {
  const x1 = s.x, y1 = s.y, x2 = s.x + (s.w ?? cw), y2 = s.y + (s.h ?? ch);
  return `polygon(evenodd, 0 0, ${cw}px 0, ${cw}px ${ch}px, 0 ${ch}px, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
}

function App() {
  const { template, needsClick, media, game, line, playback } = useStage();
  // 玩游戏的时候放视频：视频照放（游戏画面让给视频）
  const mode: Mode = media ? 'video' : game ? 'game' : 'chat';
  const slots = useMemo(() => (template ? arrange(template, mode) : []), [template, mode]);
  // 字幕和终端摆在同一块（看视频、玩游戏的布局）：她说话时（和字幕退场那一会儿）只露字幕，说完换回终端
  const [speaking] = useLinger(line, SUBTITLE_LINGER_MS);
  const subtitle = slots.find((s) => s.type === 'subtitle' && !s.hidden);
  const sharesSubtitle = (p: Slot) => p.type === 'terminal' && !!subtitle && overlaps(p, subtitle);
  const { width, height } = useViewport();
  // 模板自己的样式：每次换模板、每次打开页面都重新取（服务器让浏览器缓存一小时，改了模板刷新一下就要看到）。
  // 样式里的相对路径（url("room.jpg")）换成带 token 的地址，模板就能直接引用自己目录里的图
  useEffect(() => {
    if (!template) return;
    const tag = document.createElement('style');
    let cancelled = false;
    void fetch(`${assetUrl('templates', template.id, 'style.css')}&v=${Date.now()}`)
      .then((res) => (res.ok ? res.text() : ''))
      .then((css) => {
        if (cancelled) return;
        tag.textContent = css.replace(/url\((['"]?)(?![a-z]+:|\/|#)([^'")]+)\1\)/gi, (_, _q, file: string) => `url("${assetUrl('templates', template.id, file)}")`);
        document.head.append(tag);
      })
      .catch(() => {});
    return () => { cancelled = true; tag.remove(); };
  }, [template?.id]);
  if (!template) return <div className="ls-loading">舞台连接中…</div>;
  const [cw, ch] = template.canvas;
  // 游戏窗口由 OBS 垫在舞台下面：背景和前景在游戏位挖个洞，透出窗口
  const gameSlot = mode === 'game' && game && 'window' in game ? slots.find((s) => s.type === 'game') : undefined;
  const hole: React.CSSProperties | undefined = gameSlot ? { clipPath: holePath(gameSlot, cw, ch) } : undefined;
  const scale = Math.min(width / cw, height / ch);
  return (
    <div className="ls-viewport" data-playback-state={playback.state} data-playback-line-id={playback.lineId ?? ''} data-last-ended-id={playback.lastEndedId ?? ''}>
      <div
        className={`ls-canvas ls-template-${template.id} ls-mode-${mode}`}
        style={{ width: cw, height: ch, transform: `scale(${scale})`, left: (width - cw * scale) / 2, top: (height - ch * scale) / 2, ...template.theme } as React.CSSProperties}
      >
        {/* 背景和前景各几层空的 div：模板拿它们（和各自的 ::before / ::after）画光、气泡、云……，挂件在中间 */}
        <div className="ls-backdrop" style={hole}><i className="ls-layer ls-layer-1" /><i className="ls-layer ls-layer-2" /><i className="ls-layer ls-layer-3" /></div>
        {slots.map((p) => <Placed key={p.key} p={p} covered={!!speaking && sharesSubtitle(p)} />)}
        <div className="ls-overlay" style={hole}><i className="ls-layer ls-layer-1" /><i className="ls-layer ls-layer-2" /></div>
        <Notice />
      </div>
      {!preview && playback.detail && <div className="ls-audio-status" role="status">{playback.detail}</div>}
      {needsClick && !preview && (
        <button className="ls-unlock" onClick={unlockAudio}>点一下启用后续语音（上一句若播放失败，不会自动重播）</button>
      )}
    </div>
  );
}

function AudioSource() {
  const { needsClick, playback } = useStage();
  return (
    <div className="ls-audio-source" data-playback-state={playback.state} data-playback-line-id={playback.lineId ?? ''} data-last-ended-id={playback.lastEndedId ?? ''}>
      {needsClick && <button className="ls-unlock" onClick={unlockAudio}>点一下启用后续语音</button>}
    </div>
  );
}

function SubtitlePage({ line }: { line: Line }) {
  const chars = useMemo(() => [...line.text], [line.text]);
  const pages = useMemo(() => paginate(chars, 32), [chars]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const updatePage = () => {
      const position = Math.max(0, Math.min(chars.length, litChars(line, chars.length)) - 1);
      setPage(Math.max(0, pages.findIndex(([from, to]) => position >= from && position < to)));
    };
    updatePage();
    if (pages.length <= 1) return;
    const timer = setInterval(updatePage, 100);
    return () => clearInterval(timer);
  }, [line, pages, chars.length]);

  const [from, to] = pages[page] ?? [0, chars.length];
  const text = chars.slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return <p data-subtitle-id={line.id}>{line.speaker ? `${line.speaker}：` : ''}{text}</p>;
}

function SubtitleSource() {
  const { line } = useStage();
  return (
    <div className="ls-subtitle-source">
      {line && <SubtitlePage key={line.id} line={line} />}
    </div>
  );
}

function ListenSource() {
  const { connected, listening, needsClick, playback } = useStage();
  useEffect(() => {
    addEventListener('pagehide', stopListening);
    return () => {
      removeEventListener('pagehide', stopListening);
      stopListening();
    };
  }, []);

  let status = '仅在本机播放';
  if (needsClick) status = listening === 'active' ? '播放受阻，可停止后重试' : '播放受阻，请重试';
  else if (listening === 'starting') status = '正在启用';
  else if (listening === 'active') {
    if (!connected) status = '正在连接';
    else if (playback.state === 'playing') status = '正在播放';
    else if (playback.state === 'timeout') status = '本句播放超时';
    else if (playback.state === 'failed') status = '本句播放失败';
    else status = '等待语音';
  }
  const enabled = listening !== 'off';
  return (
    <div className="ls-listen" data-playback-state={playback.state} data-last-ended-id={playback.lastEndedId ?? ''}>
      <button type="button" onClick={enabled ? stopListening : startListening}>{enabled ? '停止试听' : '启用试听'}</button>
      <span role="status">{status}</span>
    </div>
  );
}

if (sourceMode !== 'listen') connect();
const Page = sourceMode === 'audio' ? AudioSource
  : sourceMode === 'subtitles' ? SubtitleSource
  : sourceMode === 'listen' ? ListenSource : App;
createRoot(document.getElementById('root')!).render(<Page />);
