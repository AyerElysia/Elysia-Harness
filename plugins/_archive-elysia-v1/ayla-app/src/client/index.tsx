/**
 * Ayla channel settings: one settings section plus one sidebar entry.
 *
 * The page never keeps its own copy of a value: it renders the Host's describe
 * mirror through ctx.configForms and writes with form.set(), which carries the
 * namespace revision so a stale read is refused instead of overwriting.
 */
import * as React from 'react'

export const ENTRY_ID = 'elysia-ayla-app'
export const PANEL_ID = '@elysia/ayla-app'

export const inject = ['slots', 'configForms']

const MODES = ['auto', 'elyh', 'standalone'] as const

const TEXT_FIELDS = [
  { key: 'baseUrl', label: '后端地址', hint: 'Ayla 后端根地址（明文 http 仅限本机/内网）', ph: 'http://127.0.0.1:8100' },
  { key: 'username', label: '账号', hint: '爱莉在 Ayla 里的账号', ph: 'elysia' },
  { key: 'password', label: '密码', hint: '保存后宿主脱敏，不回显', ph: '', secret: true },
  { key: 'workspaceDir', label: '会话工作区', hint: '仅独立形态使用；留空用默认目录', ph: '' },
] as const

const ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: '12px 0', borderBottom: '1px solid rgba(127,127,127,.18)',
}
const INPUT: React.CSSProperties = {
  width: 280, padding: '6px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
}

function AylaIcon(): React.ReactElement {
  return React.createElement('svg', {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  React.createElement('circle', { cx: 12, cy: 12, r: 9 }),
  React.createElement('path', { d: 'M7.5 14.5c1.5-4 3-6 4.5-6s3 2 4.5 6' }),
  React.createElement('path', { d: 'M9.6 16.4c.8-2 1.6-3 2.4-3s1.6 1 2.4 3' }))
}

function Section({ form }: { form: any }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (l: () => void) => form.subscribe(l),
    () => form.getSnapshot(),
  )
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const value: Record<string, unknown> = snapshot.value ?? {}
  const status: string = snapshot.status
  const writable: boolean = snapshot.writable !== false
  const hostMode: string = typeof value.mode === 'string' ? value.mode : 'auto'
  // The select shows the pending choice so it moves as the user picks; the
  // Host only changes once save() writes it.
  const mode: string = drafts.mode ?? hostMode
  const pending: Record<string, string> = drafts
  const dirty = Object.keys(pending).length > 0

  React.useEffect(() => {
    if (msg.length > 0) {
      // Also printed so a screenshot of the console is enough to diagnose.
      console.info('[ayla-app] ' + msg)
    }
  }, [msg])

  const save = async (): Promise<void> => {
    if (!dirty) return
    setBusy(true); setMsg('')
    const failed: string[] = []
    try {
      for (const [k, v] of Object.entries(pending)) {
        try {
          const ok = await form.set(k, v)
          console.info('[ayla-app] set ' + k + ' -> ' + String(ok))
          if (ok !== true) failed.push(k + ' 被宿主拒绝')
        } catch (error) {
          failed.push(k + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      if (failed.length === 0) { setDrafts({}); setMsg('已保存') }
      else setMsg('保存失败 — ' + failed.join('；'))
    } finally { setBusy(false) }
  }

  const textRow = (f: typeof TEXT_FIELDS[number]): React.ReactElement => React.createElement('div', { key: f.key, style: ROW },
    React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      React.createElement('span', null, f.label),
      React.createElement('span', { style: { fontSize: 12, opacity: .6 } }, f.hint)),
    React.createElement('input', {
      type: f.secret === true ? 'password' : 'text',
      placeholder: f.ph,
      value: drafts[f.key] ?? (typeof value[f.key] === 'string' ? value[f.key] : ''),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDrafts({ ...drafts, [f.key]: e.target.value }),
      style: INPUT,
    }))

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 760 } },
    React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13, opacity: .75 } },
      'Ayla 应用里给爱莉发消息，回复回到同一个会话。改完点「保存」，然后重载页面生效。'),
    React.createElement('p', { style: { fontSize: 12, opacity: .55, margin: '0 0 6px' } },
      'entry ' + ENTRY_ID + ' · status ' + status + (writable ? ' · 可写' : ' · 不可写') + ' · rev ' + String(snapshot.revision)),
    ...TEXT_FIELDS.map(textRow),
    React.createElement('div', { key: 'mode', style: ROW },
      React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        React.createElement('span', null, '形态'),
        React.createElement('span', { style: { fontSize: 12, opacity: .6 } }, 'auto：装了 conscious-mind 就用它，否则自建会话')),
      React.createElement('select', {
        value: mode,
        disabled: !writable,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDrafts({ ...drafts, mode: e.target.value }),
        style: { ...INPUT, width: 160 },
      }, ...MODES.map(m => React.createElement('option', { key: m, value: m }, m)))),
    React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', paddingTop: 14 } },
      React.createElement('button', {
        type: 'button',
        onClick: () => { void save() },
        disabled: !dirty || busy || !writable,
        style: {
          padding: '7px 18px', borderRadius: 9, border: 'none', fontSize: 13, fontWeight: 600,
          cursor: dirty && !busy && writable ? 'pointer' : 'default',
          background: dirty && writable ? '#4f7cff' : 'rgba(127,127,127,.25)',
          color: dirty && writable ? '#fff' : 'inherit',
        },
      }, busy ? '保存中…' : '保存'),
      dirty ? React.createElement('span', { style: { fontSize: 12, opacity: .7 } }, '有未保存修改') : null,
      msg ? React.createElement('span', { style: { fontSize: 12, opacity: .85 } }, msg) : null))
}

function Panel({ form }: { form: any }): React.ReactElement {
  return React.createElement('div', { style: { padding: '24px 28px', overflow: 'auto', height: '100%' } },
    React.createElement('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, 'Ayla 通道'),
    React.createElement(Section, { form }))
}

export function apply(ctx: any): void {
  const form = ctx.configForms.get(ENTRY_ID)
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => {
    const a = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'ayla', order: 40, label: () => 'Ayla',
    }, () => React.createElement(Section, { form })))
    const b = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 3, label: () => 'Ayla',
    }, AylaIcon))
    const c = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID },
      () => React.createElement(Panel, { form })))
    return () => { void a; void b; void c }
  }), 'elysia-ayla-app: settings surfaces')
}
