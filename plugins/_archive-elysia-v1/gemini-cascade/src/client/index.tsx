/** Native DSH voice controls; the main session keeps its own composer. */
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type FormEvent } from 'react'
import { CascadeController } from './controller.ts'
import { isVoiceSession, MAIN_SESSION_ID, SESSION_ID, type Snapshot, type VoiceSessionId } from './protocol.ts'
import { STYLES } from './styles.ts'

export const inject = ['slots', 'uiWorkspace', 'uiSession', 'connection']
const ID = '@elysia/gemini-cascade'
type Seat = Readonly<{ kind: 'elysia-gemini-cascade'; key: string; sessionId: string }>
type Route = { sessionId?: string; pendingInteraction?: unknown }
interface ClientContext {
  effect(setup: () => (() => void), name: string): unknown
  on(event: 'connection/reset', listener: () => void): () => void
  uiWorkspace: { openSession(sessionId: string): void }
  uiSession: { registerPendingInteraction<T extends Seat>(rank: (item: T) => number):
    (item: T, delegate: () => Promise<void>) => () => void }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register<T extends object>(options: {
      name: string; id?: string; order?: number; priority?: number;
      inject?: (sessionId: string) => Partial<T>;
      select?: (props: Route) => Seat | null;
    }, view: ComponentType<T>): () => void
  }
}
const STATUS: Record<Snapshot['phase'], string> = {
  idle: '通话已结束',
  disclosure: '正在确认语音处理方式',
  consent: '开始语音通话',
  connecting: '正在连接',
  microphone: '等待麦克风',
  waiting: '正在接通爱莉',
  listening: '爱莉在听',
  transcribing: '正在识别语音',
  thinking: '爱莉正在想',
  speaking: '爱莉在说话',
}

function Phone({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3.6H4.8A1.8 1.8 0 0 0 3 5.5 17.1 17.1 0 0 0 18.5 21a1.8 1.8 0 0 0 1.9-1.8V17l-4.7-1.7-1.4 2a13.1 13.1 0 0 1-7.6-7.6l2-1.4L7 3.6Z" />
  </svg>
}

export function apply(ctx: ClientContext): void {
  const publishSeat = ctx.uiSession.registerPendingInteraction<Seat>(() => -1)
  let seat: Seat | undefined
  let sequence = 0
  const presentations = new Map<VoiceSessionId, number>()
  const controller = new CascadeController(() => {
    const reserved: Seat = { kind: 'elysia-gemini-cascade', sessionId: SESSION_ID, key: ID + ':' + (++sequence) }
    seat = reserved
    const remove = publishSeat(reserved, async () => { controller.end('通话已结束。') })
    return () => { if (seat === reserved) seat = undefined; remove() }
  })
  const useCall = (): Snapshot => useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  function Shortcut({ wide }: { wide: boolean }) {
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const pending = useRef<AbortController | null>(null)
    useEffect(() => () => pending.current?.abort(), [])
    async function open() {
      if (pending.current) return
      const owner = new AbortController()
      pending.current = owner
      setBusy(true)
      setNotice('')
      try {
        const session = await controller.openSession(AbortSignal.any([owner.signal, AbortSignal.timeout(12000)]))
        if (!owner.signal.aborted) ctx.uiWorkspace.openSession(session)
      } catch {
        if (!owner.signal.aborted) setNotice('暂时无法打开通话试用会话。')
      } finally {
        if (pending.current === owner) {
          pending.current = null
          if (!owner.signal.aborted) setBusy(false)
        }
      }
    }
    return <div className="egc-shortcut">
      <button type="button" className="egc-button egc-shortcut-button" onClick={() => { void open() }}
        aria-label="爱莉通话" title="打开爱莉通话" disabled={busy}>
        <Phone />{wide && <span>{busy ? '正在打开…' : '爱莉通话'}</span>}
      </button>
      {notice && <p className="egc-notice" role="status">{notice}</p>}
    </div>
  }

  function Start({ sessionId }: { sessionId?: VoiceSessionId }) {
    const call = useCall()
    if (!sessionId || call.phase !== 'idle') return null
    const label = sessionId === MAIN_SESSION_ID ? '和主意识爱莉通话' : '和爱莉通话'
    return <span className="egc-start">
      {call.sessionId === sessionId && call.notice && <span className="egc-inline-notice" role="status">{call.notice}</span>}
      <button type="button" className="egc-button egc-icon-button" aria-label={label}
        title={label} onClick={() => { void controller.requestConsent(sessionId) }}><Phone /></button>
    </span>
  }

  function CallSeat({ sessionId }: { sessionId: VoiceSessionId }) {
    const call = useCall()
    const isMain = sessionId === MAIN_SESSION_ID
    const [draft, setDraft] = useState('')
    const [sending, setSending] = useState(false)
    useEffect(() => {
      presentations.set(sessionId, (presentations.get(sessionId) ?? 0) + 1)
      return () => {
        const count = (presentations.get(sessionId) ?? 1) - 1
        if (count > 0) presentations.set(sessionId, count)
        else presentations.delete(sessionId)
        // A StrictMode remount reacquires the seat before the microtask.
        queueMicrotask(() => {
          const current = controller.getSnapshot()
          if (!presentations.has(sessionId) && current.sessionId === sessionId && current.phase !== 'idle') {
            controller.end('已离开会话，通话结束。')
          }
        })
      }
    }, [sessionId])
    async function send(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (sending || !draft.trim()) return
      const submitted = draft
      setSending(true)
      try {
        if (await controller.sendText(submitted)) setDraft(value => value === submitted ? '' : value)
      } finally { setSending(false) }
    }
    if (call.phase === 'idle' || call.sessionId !== sessionId) return null
    const setup = call.phase === 'disclosure' || call.phase === 'consent'
    const consent = call.phase === 'consent' && call.inputMode !== null
    const available = call.micReady && call.workerReady
    const displayed = call.phase === 'speaking' && !call.micReady ? STATUS.microphone : STATUS[call.phase]
    const title = isMain ? '主意识 · 语音通话' : '和爱莉通话'
    return <div className={isMain ? 'egc-seat egc-main-seat' : 'egc-seat'}>
      <section className="egc-card" aria-label={title}>
        <div className="egc-bar">
          <span className="egc-indicator" data-phase={call.phase} aria-hidden="true">
            <i /><i /><i /><i /><i />
          </span>
          <div className="egc-status">
            <strong>{title}</strong>
            <span role="status">{displayed}{call.muted ? ' · 麦克风已静音' : ''}</span>
          </div>
          <div className="egc-actions">
            {!setup && call.playbackBlocked && <button type="button" className="egc-button"
              onClick={() => { void controller.enablePlayback() }}>允许播放</button>}
            {!setup && <button type="button" className="egc-button" disabled={!call.micReady}
              aria-pressed={call.muted} onClick={() => { void controller.toggleMute() }}>
              {call.muted ? '取消静音' : '静音'}
            </button>}
            <button type="button" className={setup ? 'egc-button' : 'egc-button egc-hangup'}
              onClick={() => controller.end(setup ? '' : '通话已结束。')}>{setup ? '取消' : '挂断'}</button>
          </div>
        </div>
        {setup ? consent && <div className="egc-consent">
          <p>{call.inputMode === 'local-asr'
            ? isMain
              ? '开启麦克风后，原声只在 Spark 上识别，不发送给模型渠道。转写会像普通消息一样交给主意识，并保留在这个会话里。'
              : '开启麦克风后，原声只在 Spark 上识别，不发送给模型渠道。识别文字会发给 Gemini，文字会保留在当前会话。'
            : '开启麦克风后，原声会经模型渠道送给 Gemini 处理。'}本程序不保存原声；每次最多 10 分钟。</p>
          <button type="button" className="egc-button egc-accept"
            onClick={() => { void controller.start() }}>同意并开始</button>
        </div> : isMain ? <p className="egc-note">转写和爱莉的回复都会显示在这条会话里。你也可以照常在下方打字。</p> : <>
          <p className="egc-note">通话文字显示在当前会话。</p>
          <form className="egc-form" onSubmit={event => { void send(event) }}>
            <input type="text" placeholder="通话中也可以打字" aria-label="发给爱莉的文字" autoComplete="off"
              disabled={!available} maxLength={2048} value={draft} onChange={event => setDraft(event.currentTarget.value)} />
            <button type="submit" className="egc-button" disabled={!available || sending || !draft.trim()}>发送</button>
          </form>
        </>}
        {call.notice && <p className="egc-notice" role="status">{call.notice}</p>}
      </section>
    </div>
  }

  function IsolatedCallSeat() {
    return <CallSeat sessionId={SESSION_ID} />
  }

  function MainCallDock({ current }: { current?: boolean }) {
    return current ? <CallSeat sessionId={MAIN_SESSION_ID} /> : null
  }

  function MainHangup({ current }: { current?: boolean }) {
    const call = useCall()
    // Native approvals/questions may cover the composer. The header keeps a
    // visible way to turn off the main mic without answering or cancelling them.
    if (!current || call.sessionId !== MAIN_SESSION_ID || call.phase === 'idle') return null
    const setup = call.phase === 'consent' || call.phase === 'disclosure'
    if (setup) return null
    return <button type="button" className="egc-button egc-icon-button egc-hangup"
      aria-label="挂断主意识通话" title="挂断主意识通话"
      onClick={() => controller.end('通话已结束。')}><Phone size={16} /></button>
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = ID
    style.textContent = STYLES
    document.head.append(style)
    const reset = ctx.on('connection/reset', () => { controller.end('DSH 连接已重置。请手动再拨。') })
    const leave = () => { controller.end() }
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      reset()
      controller.dispose()
      style.remove()
    }
  }, 'Gemini cascade browser owner')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: ID, order: 10,
  }, Shortcut))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: ID, order: 20,
    inject: sessionId => isVoiceSession(sessionId) ? { sessionId } : {},
  }, Start))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: ID, order: 25,
    inject: sessionId => ({ current: sessionId === MAIN_SESSION_ID }),
  }, MainCallDock))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: ID, order: 25,
    inject: sessionId => ({ current: sessionId === MAIN_SESSION_ID }),
  }, MainHangup))
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -1,
    select: ({ sessionId, pendingInteraction }) =>
      sessionId === SESSION_ID && seat && pendingInteraction === seat ? seat : null,
  }, IsolatedCallSeat))
}
