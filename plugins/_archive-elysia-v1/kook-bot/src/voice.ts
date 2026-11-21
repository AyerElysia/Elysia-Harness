/** Prepare content-addressed KOOK voice assets, transcoding WAV to MP3 when possible. */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export interface KookVoiceAsset {
  body: Uint8Array
  filename: string
  contentType: 'audio/mpeg' | 'audio/wav'
}

function transcodeWavToMp3(wav: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1',
      '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { output.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(errors).byteLength < 4096) errors.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      const audio = Buffer.concat(output)
      if (code === 0 && audio.byteLength > 0) resolve(audio)
      else reject(new Error(`ffmpeg 转码失败: ${Buffer.concat(errors).toString('utf8').slice(0, 1000)}`))
    })
    child.stdin.on('error', reject)
    child.stdin.end(wav)
  })
}

/** Keep MP3 verbatim; prefer MP3 for native KOOK voice, with WAV as a valid fallback. */
export async function prepareKookVoiceAsset(audio: Uint8Array, mediaType: 'audio/wav'): Promise<KookVoiceAsset> {
  let body = audio
  let contentType: KookVoiceAsset['contentType'] = mediaType
  let suffix = '.wav'
  const isMp3 = audio.byteLength >= 3
    && (String.fromCharCode(...audio.slice(0, 3)) === 'ID3' || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0))
  if (isMp3) {
    contentType = 'audio/mpeg'
    suffix = '.mp3'
  } else {
    try {
      body = await transcodeWavToMp3(audio)
      contentType = 'audio/mpeg'
      suffix = '.mp3'
    } catch {
      // KOOK also accepts WAV uploads; keep the real media type and extension.
    }
  }
  const digest = createHash('sha256').update(body).digest('hex')
  return {
    body,
    contentType,
    filename: `elysia-voice-${digest.slice(0, 16)}${suffix}`,
  }
}
