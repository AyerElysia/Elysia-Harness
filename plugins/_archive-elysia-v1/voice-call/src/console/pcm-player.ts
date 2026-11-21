import { PCM_WORKLET_SOURCE } from './pcm-worklet.ts'
import type { VoiceEvent } from '../protocol.ts'
export interface PcmReceipt { epoch: number; segmentId: string; playedFrames: number; fullyPlayed: boolean }
export interface CallPlayer {
  prepare(): Promise<void>
  reset(epoch: number): void
  pcm(event: Extract<VoiceEvent, { type: 'pcm' }>): void
  end(event: Extract<VoiceEvent, { type: 'segment-end' }>): void
  dispose(): void
}
export class PcmDecoder {
  private readonly chunks = new Map<string, { next: number; carry: number | null; frames: number }>()
  private readonly finished = new Set<string>()
  reset(): void { this.chunks.clear(); this.finished.clear() }
  decode(segmentId: string, index: number, audio: string): Float32Array {
    if (!Number.isSafeInteger(index) || index < 0 || audio.length > 256 * 1024) throw new Error('invalid_pcm_chunk')
    if (this.finished.has(segmentId)) throw new Error('pcm_segment_already_ended')
    const state = this.chunks.get(segmentId) ?? { next: 0, carry: null, frames: 0 }
    if (index !== state.next) throw new Error('pcm_chunk_gap')
    const raw = atob(audio)
    const bytes = new Uint8Array(raw.length + (state.carry === null ? 0 : 1))
    let offset = 0
    if (state.carry !== null) bytes[offset++] = state.carry
    for (let i=0;i<raw.length;i++) bytes[offset+i] = raw.charCodeAt(i)
    const result = new Float32Array(Math.floor(bytes.length / 2))
    for (let i=0;i<result.length;i++) {
      const unsigned = bytes[i*2]! | (bytes[i*2+1]! << 8)
      result[i] = (unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned) / 32768
    }
    state.carry = bytes.length % 2 ? bytes[bytes.length-1]! : null
    state.next++; state.frames += result.length
    this.chunks.set(segmentId,state)
    return result
  }
  finish(segmentId: string, expectedFrames?: number): void {
    const state = this.chunks.get(segmentId)
    if (!state || this.finished.has(segmentId)) throw new Error('unknown_pcm_segment')
    if (state.carry !== null) throw new Error('incomplete_pcm_sample')
    if (expectedFrames !== undefined && state.frames !== expectedFrames) throw new Error('pcm_frame_count_mismatch')
    this.chunks.delete(segmentId); this.finished.add(segmentId)
  }
}
/** Reports frames actually consumed by the worklet, not merely fetched bytes. */
export class PcmPlayer implements CallPlayer {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private epoch = 0
  private closed = false
  private readonly decoder = new PcmDecoder()
  constructor(private readonly receipt: (value: PcmReceipt) => void,
    private readonly status: (status: 'playing' | 'idle' | 'failed') => void) {}
  async prepare(): Promise<void> {
    const context = new AudioContext({ sampleRate: 24000 })
    this.context = context
    const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
      if (this.closed) { await context.close(); return }
      if (context.sampleRate !== 24000) throw new Error('unsupported_audio_sample_rate')
      const node = new AudioWorkletNode(context,'elysia-voice-pcm',{ numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1] })
      this.node = node
      node.port.onmessage = ({data}: MessageEvent<unknown>) => {
        if (this.closed || !data || typeof data !== 'object') return
        const value = data as { type?: string; epoch?: number; segmentId?: string; playedFrames?: number; fullyPlayed?: boolean }
        if (value.type === 'receipt' && typeof value.segmentId === 'string' && Number.isSafeInteger(value.epoch)
          && Number.isSafeInteger(value.playedFrames) && (value.playedFrames ?? -1) >= 0 && typeof value.fullyPlayed === 'boolean') {
          this.receipt(value as PcmReceipt)
        } else if (value.epoch === this.epoch && value.type === 'progress') this.status('playing')
        else if (value.epoch === this.epoch && value.type === 'idle') this.status('idle')
        else if (value.type === 'error') this.status('failed')
      }
      node.connect(context.destination)
      this.reset(this.epoch)
      await context.resume()
      if (context.state !== 'running') throw new Error('audio_playback_refused')
    } catch (error) { this.dispose(); throw error }
    finally { URL.revokeObjectURL(url) }
  }
  reset(epoch: number): void {
    this.epoch = epoch; this.decoder.reset()
    this.node?.port.postMessage({ type:'reset',epoch })
  }
  pcm(event: Extract<VoiceEvent,{type:'pcm'}>): void {
    if (this.closed || !this.node || event.epoch !== this.epoch) return
    if (event.sampleRate !== 24000 || event.channels !== 1 || event.format !== 's16le') throw new Error('unsupported_pcm_format')
    const samples = this.decoder.decode(event.segmentId,event.chunkIndex,event.audio)
    if (samples.length) this.node.port.postMessage({type:'pcm',epoch:this.epoch,segmentId:event.segmentId,samples},[samples.buffer])
  }
  end(event: Extract<VoiceEvent,{type:'segment-end'}>): void {
    if (this.closed || event.epoch !== this.epoch) return
    if (!Number.isSafeInteger(event.frames) || event.frames < 0) throw new Error('invalid_segment_frames')
    this.decoder.finish(event.segmentId,event.frames)
    this.node?.port.postMessage({type:'end',epoch:this.epoch,segmentId:event.segmentId,frames:event.frames})
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.node?.port.postMessage({type:'reset',epoch:this.epoch})
    this.node?.disconnect()
    this.node = null
    if (this.context) void this.context.close().catch(() => {})
    this.context = null
    this.decoder.reset()
  }
}
