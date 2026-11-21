/** Mechanical FIFO attention: budgets delivery, never judges meaning or people. */
import type { LiveEvent } from '../live'
import type { ProjectionIntent } from '../../dsh/session'
import type { RoomHeat, Topic } from './topics'
export interface OwnerPace { welcomeGapMs?: number; welcomeOff?: boolean; thanksGapMs?: number; followGapMs?: number; chatPicks?: number }
export const TUNING = { projectionBytes: 12288, pageBytes: 4096, maxBatch: 5 }
export interface InputProjection { eventId: string; ref?: string; offset: number; nextOffset: number; totalBytes: number; complete: boolean; text: string }
export interface AttentionSnapshot { heat: RoomHeat; audience: boolean; chatsPerMin: number; pending: { chats: number; superchats: number; thanks: number; gifts: number; welcome: number; follow: number; trends: number } }
interface Pending { id: number; event: LiveEvent; projection: InputProjection }
export class LiveAttention {
  idleAfterMs = Infinity
  owner: OwnerPace = {}
  welcomeGapMs = 0
  minChatPicks = 0
  private pending: Pending[] = []
  private seenRefs = new Set<string>()
  private sequence = 0
  private lastEnd: number
  private lastIdle: number
  private speaking = false
  private online: number | undefined
  constructor(now: number) { this.lastEnd = now; this.lastIdle = now }
  setOnline(n: number | undefined): void { this.online = n }
  setAnchorId(_id: string | undefined): void {}
  setRehearsal(_value: boolean): void {}
  speechStarted(): void { this.speaking = true }
  speechEnded(now: number): void { this.lastEnd = now; this.speaking = false }
  silentMs(now: number): number { return Math.max(0, now - this.lastEnd) }
  heat(_now: number): RoomHeat { return 'unknown' }
  /** Original event has already entered the authoritative native journal. */
  observe(event: LiveEvent, _isUpdate: boolean, _now: number, ref?: string, offset = 0): void {
    if (ref && this.seenRefs.has(ref)) return
    if (this.pending.length >= 4096) throw new Error('Livestream FIFO backlog budget reached')
    const bytes = Buffer.from(JSON.stringify(event))
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length || (bytes[offset]! & 0xc0) === 0x80) throw new Error('Invalid restored UTF-8 source offset')
    let end = Math.min(bytes.length, offset + TUNING.pageBytes)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    if (ref) this.seenRefs.add(ref)
    this.pending.push({ id: ++this.sequence, event, projection: {
      eventId: event.id, ...(ref ? { ref } : {}), offset, nextOffset: end,
      totalBytes: bytes.length, complete: end === bytes.length, text: bytes.subarray(offset, end).toString('utf8'),
    } })
  }
  /** Peek a stable FIFO batch; failed or cancelled delivery does not consume it. */
  next(now: number): Topic | null {
    if (!this.pending.length) {
      const since = Math.max(this.lastEnd, this.lastIdle)
      if (!this.speaking && Number.isFinite(this.idleAfterMs) && this.idleAfterMs > 0 && now - since >= this.idleAfterMs)
        return { kind: 'idle', silentMs: now - this.lastEnd, id: `idle-${since}`, priority: 0, heat: this.heat(now), createdAt: now }
      return null
    }
    const records: InputProjection[] = []
    const ids: number[] = []
    const events: LiveEvent[] = []
    let bytes = 0
    for (const item of this.pending) {
      const size = Buffer.byteLength(JSON.stringify(item.projection))
      if (records.length && (bytes + size > TUNING.projectionBytes || records.length >= TUNING.maxBatch)) break
      records.push(item.projection); ids.push(item.id); events.push(item.event); bytes += size
      if (!item.projection.complete) break
    }
    return { kind: 'events', records, pendingIds: ids, events, id: `fifo-${records.map((r,i)=>`${ids[i]}@${r.offset}`).join('-')}`, priority: 0, heat: this.heat(now), createdAt: now }
  }
  /** Recreate a stored intent exactly, before making a newly grouped batch. */
  restoreIntent(intent: ProjectionIntent, now: number): Extract<Topic, { kind: 'events' }> {
    const pendingIds:number[]=[], records:InputProjection[]=[], events:LiveEvent[]=[]
    for(const page of intent.pages) {
      const item=this.pending.find(item=>item.projection.ref===page.ref)
      if(!item || item.projection.offset!==page.offset) throw new Error('Recovered intent does not match pending source offset')
      const bytes=Buffer.from(JSON.stringify(item.event))
      pendingIds.push(item.id);events.push(item.event)
      records.push({...page,eventId:item.event.id,text:bytes.subarray(page.offset,page.nextOffset).toString('utf8')})
    }
    const text=intent.message.content.map(p=>p.type==='text'?p.text:'').join('\n')
    return {kind:'events',records,pendingIds,events,id:intent.key,deliveryKey:intent.key,replayText:text,priority:0,heat:this.heat(now),createdAt:now}
  }
  /** A partial page advances an exact byte offset; it never consumes its unseen tail. */
  acknowledge(topic: Topic): void {
    if (topic.kind === 'idle') { this.lastIdle = topic.createdAt; return }
    if (topic.kind !== 'events') return
    for (let i=0;i<topic.pendingIds.length;i++) {
      const item=this.pending[0], page=topic.records[i]
      if (!item || !page || item.id!==topic.pendingIds[i] || item.projection.offset!==page.offset) throw new Error('Livestream FIFO acknowledgement is out of order')
      if(page.complete) this.pending.shift()
      else {
        const bytes=Buffer.from(JSON.stringify(item.event)),offset=page.nextOffset
        let end=Math.min(bytes.length,offset+TUNING.pageBytes)
        while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--
        item.projection={...item.projection,offset,nextOffset:end,complete:end===bytes.length,text:bytes.subarray(offset,end).toString('utf8')}
      }
    }
  }
  snapshot(now: number): AttentionSnapshot {
    const n = (kind: string) => this.pending.filter(p => p.event.kind === kind).length
    return { heat: this.heat(now), audience: (this.online ?? 0) > 0, chatsPerMin: 0,
      pending: { chats: n('chat'), superchats: n('superchat'), thanks: n('membership'), gifts: n('gift'), welcome: n('enter'), follow: n('follow'), trends: 0 } }
  }
}
