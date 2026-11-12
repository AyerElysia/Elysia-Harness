import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomAudioRenderer, RoomContext, StartAudio } from '@livekit/components-react';
import { createLocalAudioTrack, Room, RoomEvent, type LocalAudioTrack } from 'livekit-client';
import './style.css';

const SIGNALING_URL = 'ws://127.0.0.1:18780/';
const MAX_CALL_MS = 10 * 60_000;
const CONNECT_OPTIONS = { maxRetries: 0, rtcConfig: { iceServers: [] } };
type Phase = 'token' | 'room' | 'microphone';
type Call = {
  room: Room;
  request: AbortController;
  expiry: ReturnType<typeof setTimeout>;
  microphone?: LocalAudioTrack;
  onDisconnect: () => void;
};

async function credentials(signal: AbortSignal): Promise<{ serverUrl: string; participantToken: string }> {
  const response = await fetch('/api/token', {
    method: 'POST',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error('token_refused');
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('token_invalid');
  const {serverUrl,participantToken} = value as {serverUrl?:unknown;participantToken?:unknown};
  if (typeof serverUrl !== 'string' || new URL(serverUrl).href !== SIGNALING_URL
      || typeof participantToken !== 'string' || participantToken.length === 0) throw new Error('token_invalid');
  return {serverUrl,participantToken};
}

function release(call: Call): void {
  call.request.abort();
  clearTimeout(call.expiry);
  call.room.off(RoomEvent.Disconnected,call.onDisconnect);
  call.microphone?.stop();
  void call.room.disconnect(true).catch(() => {});
}

function failureMessage(phase: Phase, error: unknown): string {
  if (phase === 'token') return '未取得试用通话凭证。请确认本地页面和 SSH 转发仍可用。';
  if (phase === 'room') return '未能连上试用语音房间。请检查信令与媒体两路转发。';
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '浏览器未允许麦克风，通话已结束。';
  return '未能启用麦克风，通话已结束。';
}

function Pilot() {
  const active = useRef<Call | null>(null);
  const [consent,setConsent] = useState(false);
  const [room,setRoom] = useState<Room | null>(null);
  const [status,setStatus] = useState('未通话');
  const [ready,setReady] = useState(false);
  const [muted,setMuted] = useState(false);
  const [changingMute,setChangingMute] = useState(false);

  function stop(message: string, owner = active.current) {
    if (!owner || active.current !== owner) return;
    active.current = null;
    release(owner);
    setRoom(null);
    setReady(false);
    setMuted(false);
    setChangingMute(false);
    setStatus(message);
  }

  useEffect(() => {
    const close = () => {
      const owner = active.current;
      active.current = null;
      if (owner) release(owner);
    };
    const pagehide = () => stop('通话已结束。');
    window.addEventListener('pagehide',pagehide);
    return () => { window.removeEventListener('pagehide',pagehide); close(); };
  },[]);

  async function start() {
    if (!consent || active.current) return;
    if (!window.isSecureContext) { setStatus('浏览器要求安全页面才能使用麦克风。'); return; }
    const nextRoom = new Room({
      reconnectPolicy: { nextRetryDelayInMs: () => null },
      stopLocalTrackOnUnpublish: true,
    });
    const owner: Call = {
      room:nextRoom,
      request:new AbortController(),
      expiry:setTimeout(() => stop('本次试用通话已到 10 分钟上限。',owner),MAX_CALL_MS),
      onDisconnect:() => stop('通话连接已断开；不会自动重拨。',owner),
    };
    active.current = owner;
    nextRoom.on(RoomEvent.Disconnected,owner.onDisconnect);
    setRoom(nextRoom);
    setStatus('正在准备通话…');
    let phase: Phase = 'token';
    try {
      const token = await credentials(owner.request.signal);
      if (active.current !== owner) return;
      phase = 'room';
      await nextRoom.connect(token.serverUrl,token.participantToken,CONNECT_OPTIONS);
      if (active.current !== owner) { void nextRoom.disconnect(true).catch(() => {}); return; }
      phase = 'microphone';
      setStatus('已连接，等待浏览器允许使用麦克风…');
      const track = await createLocalAudioTrack({echoCancellation:true,noiseSuppression:true,autoGainControl:true});
      if (active.current !== owner) { track.stop(); return; }
      owner.microphone = track;
      await nextRoom.localParticipant.publishTrack(track);
      if (active.current !== owner) return;
      setReady(true);
      setStatus('通话中 · 麦克风已启用');
    } catch (error) {
      if (active.current === owner) stop(failureMessage(phase,error),owner);
    }
  }

  async function toggleMute() {
    const owner = active.current;
    const track = owner?.microphone;
    if (!owner || !track || changingMute) return;
    setChangingMute(true);
    try {
      if (track.isMuted) await track.unmute();
      else await track.mute();
      if (active.current !== owner) return;
      setMuted(track.isMuted);
      setStatus(track.isMuted ? '通话中 · 麦克风已静音' : '通话中 · 麦克风已启用');
    } catch {
      if (active.current === owner) setStatus('静音状态切换失败；可挂断以关闭麦克风。');
    } finally {
      if (active.current === owner) setChangingMute(false);
    }
  }

  return <main>
    <h1>和爱莉实时通话</h1>
    <p>独立 LiveKit 试用 · 最长 10 分钟</p>
    <p>本试用程序不录音、不持久保存原声；开始后，语音会交由配置的模型服务处理。</p>
    <label><input type="checkbox" checked={consent} disabled={room !== null}
      onChange={event => setConsent(event.currentTarget.checked)} />我知悉并同意本次语音处理</label>
    <div className="controls">
      <button type="button" disabled={!consent || room !== null} onClick={() => void start()}>开始通话</button>
      <button type="button" disabled={!ready || changingMute} onClick={() => void toggleMute()}>
        {muted ? '取消静音' : '静音'}
      </button>
      <button type="button" disabled={room === null} onClick={() => stop('通话已结束。')}>挂断</button>
      {room && <RoomContext.Provider value={room}>
        <RoomAudioRenderer />
        <StartAudio label="允许播放声音" />
      </RoomContext.Provider>}
    </div>
    <p role="status">{status}</p>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('app_mount_missing');
createRoot(root).render(<Pilot />);
