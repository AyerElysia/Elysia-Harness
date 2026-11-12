/** Self-contained AudioWorklet source, also executable in a VM for fake tests. */
export const PCM_WORKLET_SOURCE = `
class VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.epoch = -1; this.queue = []; this.frames = 0; this.parts = new Map(); this.playing = false;
    this.port.onmessage = ({data}) => {
      try {
        if (data.type === 'reset') {
          for (const [id,p] of this.parts) {
            if (!p.acked && p.played > 0) this.port.postMessage({type:'receipt',epoch:this.epoch,segmentId:id,playedFrames:p.played,fullyPlayed:false});
          }
          this.queue = []; this.frames = 0; this.parts.clear(); this.epoch = data.epoch; this.playing = false;
          this.port.postMessage({type:'idle',epoch:this.epoch}); return;
        }
        if (data.epoch !== this.epoch) return;
        let p = this.parts.get(data.segmentId);
        if (!p) { p = {played:0,expected:null,acked:false}; this.parts.set(data.segmentId,p); }
        if (data.type === 'pcm') {
          if (!(data.samples instanceof Float32Array) || this.frames + data.samples.length > 24000 * 8) throw new Error('pcm_buffer_overflow');
          this.queue.push({id:data.segmentId, samples:data.samples, offset:0}); this.frames += data.samples.length;
        } else if (data.type === 'end') { p.expected = data.frames; this.ack(data.segmentId,p); }
      } catch (_) { this.port.postMessage({type:'error',epoch:this.epoch,code:'pcm_player_protocol_error'}); }
    };
  }
  ack(id,p) {
    if (p.expected !== null && p.played === p.expected && !p.acked) {
      p.acked = true;
      this.port.postMessage({type:'receipt',epoch:this.epoch,segmentId:id,playedFrames:p.played,fullyPlayed:true});
    }
  }
  process(_inputs,outputs) {
    const out = outputs[0] && outputs[0][0]; if (!out) return true;
    out.fill(0); let i=0;
    while (i<out.length && this.queue.length) {
      const entry=this.queue[0], count=Math.min(out.length-i,entry.samples.length-entry.offset);
      out.set(entry.samples.subarray(entry.offset,entry.offset+count),i); i+=count; entry.offset+=count; this.frames-=count;
      const p=this.parts.get(entry.id); p.played+=count; this.ack(entry.id,p);
      if (entry.offset===entry.samples.length) this.queue.shift();
    }
    if (i && !this.playing) { this.playing = true; this.port.postMessage({type:'progress',epoch:this.epoch}); }
    if (!this.queue.length && i) { this.playing = false; this.port.postMessage({type:'idle',epoch:this.epoch}); }
    return true;
  }
}
registerProcessor('elysia-voice-pcm',VoicePcmProcessor);
`
