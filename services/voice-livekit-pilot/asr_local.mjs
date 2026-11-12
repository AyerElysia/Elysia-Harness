/** One local SenseVoice CPU recognizer for the isolated voice pilot; no audio is written or logged. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { lstat, open, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const HOST = '127.0.0.1'
const PORT = 18796
const SAMPLE_RATE = 16_000
export const MIN_BYTES = 6_400
export const MAX_BYTES = 640_000
const MAX_TEXT = 1_024
const BOOT_MS = 30_000
const READ_MS = 4_000
const NATIVE_MS = 8_000
const dshRuntime = new URL('../../dsh/packages/experimental/speech-to-text-sensevoice/', import.meta.url)

function controlledError(code) {
  return Object.assign(new Error(code), { code })
}

function fixedJson(res, status, value) {
  if (res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  })
  res.end(body)
}

function permits(req, key) {
  const auth = req.headers.authorization
  if (typeof auth !== 'string' || auth.length > 520) return false
  const actual = Buffer.from(auth)
  const expected = Buffer.from('Bearer ' + key)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readPcm(req, size) {
  const pcm = Buffer.alloc(size)
  let offset = 0
  const timer = setTimeout(() => req.destroy(), READ_MS)
  timer.unref()
  try {
    for await (const chunk of req) {
      if (offset + chunk.length > size) throw controlledError('asr_bad_audio')
      chunk.copy(pcm, offset)
      offset += chunk.length
    }
    if (offset !== size) throw controlledError('asr_bad_audio')
    return pcm
  } catch (err) {
    pcm.fill(0)
    throw err
  } finally { clearTimeout(timer) }
}

export function pcmToWave(pcm) {
  if (pcm.length < MIN_BYTES || pcm.length > MAX_BYTES || pcm.length % 2 !== 0) {
    throw controlledError('asr_bad_audio')
  }
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0)
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(SAMPLE_RATE, 24)
  out.writeUInt32LE(SAMPLE_RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(pcm.length, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(out, 44)
  return out
}

/** Exports an injectable transport so boundary tests do not load models or send audio off-host. */
export function createAsrServer({ key, transcribe, ready = () => true, authority = HOST + ':' + PORT }) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.~-]{24,512}$/u.test(key)) throw controlledError('asr_invalid_key')
  let busy = false
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: READ_MS, requestTimeout: 12_000 }, async (req, res) => {
    if (req.socket.remoteAddress !== HOST || req.headers.host !== authority || req.headers.origin !== undefined
      || req.headers['sec-fetch-site'] !== undefined) {
      fixedJson(res, 403, { error: 'asr_forbidden' })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      const healthy = ready()
      fixedJson(res, healthy ? 200 : 503, { ready: healthy })
      return
    }
    if (req.method !== 'POST' || req.url !== '/transcribe') {
      fixedJson(res, 404, { error: 'asr_not_found' })
      return
    }
    if (!permits(req, key)) {
      fixedJson(res, 401, { error: 'asr_unauthorized' })
      return
    }
    if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['transfer-encoding'] !== undefined
      || req.headers['content-encoding'] !== undefined) {
      fixedJson(res, 415, { error: 'asr_bad_media' })
      return
    }
    const rawSize = req.headers['content-length']
    const size = typeof rawSize === 'string' && /^[1-9][0-9]{0,5}$/u.test(rawSize) ? Number(rawSize) : 0
    if (size < MIN_BYTES || size > MAX_BYTES || size % 2 !== 0) {
      fixedJson(res, 400, { error: 'asr_bad_audio' })
      return
    }
    if (!ready() || busy) {
      fixedJson(res, 503, { error: busy ? 'asr_busy' : 'asr_not_ready' })
      return
    }
    busy = true
    let pcm
    try {
      pcm = await readPcm(req, size)
      if (res.destroyed) return
      const text = await transcribe(pcm)
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw controlledError('asr_inference_failed')
      fixedJson(res, 200, { text: text.trim() })
    } catch (error) {
      const code = ['asr_bad_audio', 'asr_timeout'].includes(error?.code) ? error.code : 'asr_inference_failed'
      fixedJson(res, code === 'asr_bad_audio' ? 400 : code === 'asr_timeout' ? 504 : 500, { error: code })
    } finally {
      pcm?.fill(0)
      busy = false
    }
  })
  server.keepAliveTimeout = 500
  server.maxConnections = 8
  return server
}

async function validateRuntime(runtime) {
  if (typeof runtime !== 'string' || !/^\/tmp\/elyharn-local-asr\.[A-Za-z0-9]{8}$/u.test(runtime)) {
    throw controlledError('asr_invalid_runtime')
  }
  const stat = await lstat(runtime)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw controlledError('asr_invalid_runtime')
  }
  return runtime
}

async function readKey(keyFile) {
  if (typeof keyFile !== 'string' || !keyFile.startsWith('/')) throw controlledError('asr_invalid_key')
  const fh = await open(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fh.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 513) {
      throw controlledError('asr_invalid_key')
    }
    const value = (await fh.readFile('utf8')).trim()
    if (!/^[A-Za-z0-9_.~-]{24,512}$/u.test(value)) throw controlledError('asr_invalid_key')
    return value
  } finally { await fh.close() }
}

async function verifiedAssets(runtime) {
  const manifest = JSON.parse(await readFile(new URL('runtime/assets.json', dshRuntime), 'utf8'))
  const paths = {}
  for (const [kind, asset] of Object.entries({ model: manifest.models.int8, tokens: manifest.tokens, vad: manifest.vad })) {
    if (!['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'].includes(asset.name)
      || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw controlledError('asr_invalid_manifest')
    }
    const path = join(runtime, asset.name)
    let fd
    try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch { throw controlledError('asr_assets_missing') }
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size !== asset.bytes) {
        throw controlledError('asr_bad_asset')
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path, { fd: fd.fd, autoClose: false })) hash.update(chunk)
      if (hash.digest('hex') !== asset.sha256) throw controlledError('asr_bad_asset')
    } finally { await fd.close() }
    paths[kind] = path
  }
  return paths
}

async function nativeWorker() {
  try {
    const { createTranscriber } = await import(new URL('src/inference.ts', dshRuntime))
    const recognize = createTranscriber({
      ...workerData, threads: 2, segmentSeconds: 20, vadThreshold: 0.5,
      minSpeechSeconds: 0.25, minSilenceSeconds: 0.5, vadOnsetPaddingSeconds: 0.3,
      maxAudioBytes: MAX_BYTES + 44,
    })
    parentPort.postMessage({ ready: true })
    parentPort.on('message', ({ pcm }) => {
      const bytes = new Uint8Array(pcm)
      let wave
      try {
        wave = pcmToWave(bytes)
        const { text } = recognize(wave, 'auto')
        parentPort.postMessage({ text })
      } catch { parentPort.postMessage({ error: 'asr_inference_failed' }) }
      finally { bytes.fill(0); wave?.fill(0) }
    })
  } catch {
    parentPort.postMessage({ error: 'asr_native_init_failed' })
    parentPort.close()
  }
}

async function startNative(paths) {
  const worker = new Worker(new URL(import.meta.url), { workerData: paths, stdout: true, stderr: true })
  worker.stdout.resume()
  worker.stderr.resume()
  let active
  let ready = false
  let boot
  const waitBoot = new Promise((resolveBoot, reject) => { boot = { resolveBoot, reject } })
  const bootTimer = setTimeout(() => boot?.reject(controlledError('asr_boot_timeout')), BOOT_MS)
  worker.on('message', (result) => {
    if (boot) {
      if (result?.ready === true) {
        ready = true
        boot.resolveBoot()
      } else boot.reject(controlledError('asr_native_init_failed'))
      boot = undefined
      return
    }
    if (!active) return
    const job = active
    active = undefined
    clearTimeout(job.timer)
    if (typeof result?.text === 'string') job.resolve(result.text)
    else job.reject(controlledError('asr_inference_failed'))
  })
  function failed() {
    ready = false
    boot?.reject(controlledError('asr_native_init_failed'))
    if (!active) return
    const job = active
    active = undefined
    clearTimeout(job.timer)
    job.reject(controlledError('asr_inference_failed'))
  }
  worker.on('error', failed)
  worker.on('exit', failed)
  try { await waitBoot }
  catch (error) { void worker.terminate(); throw error }
  finally { clearTimeout(bootTimer) }
  return {
    ready: () => ready,
    transcribe(pcm) {
      if (!ready || active) return Promise.reject(controlledError('asr_inference_failed'))
      return new Promise((resolveJob, reject) => {
        const owned = new Uint8Array(pcm.length)
        owned.set(pcm)
        const timer = setTimeout(() => {
          const job = active
          active = undefined
          ready = false
          job?.reject(controlledError('asr_timeout'))
          void worker.terminate()
        }, NATIVE_MS)
        active = { resolve: resolveJob, reject, timer }
        try { worker.postMessage({ pcm: owned.buffer }, [owned.buffer]) }
        catch { failed() }
      })
    },
    close: () => worker.terminate(),
  }
}

function parseArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--verify') {
      if (result.verify) throw controlledError('asr_usage')
      result.verify = true
    } else if (flag === '--runtime' || flag === '--key-file') {
      const field = flag === '--runtime' ? 'runtime' : 'keyFile'
      if (result[field] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw controlledError('asr_usage')
      result[field] = argv[++i]
    } else throw controlledError('asr_usage')
  }
  if (!result.runtime || (!result.verify && !result.keyFile) || (result.verify && result.keyFile)) {
    throw controlledError('asr_usage')
  }
  return result
}

async function main() {
  const { runtime, keyFile, verify } = parseArgs(process.argv.slice(2))
  const paths = await verifiedAssets(await validateRuntime(runtime))
  if (verify) {
    console.log('local_asr_assets_verified')
    return
  }
  const key = await readKey(keyFile)
  const native = await startNative(paths)
  const server = createAsrServer({ key, transcribe: native.transcribe, ready: native.ready })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => { server.off('error', reject); done() })
  }).catch(async () => {
    await native.close()
    throw controlledError('asr_bind_failed')
  })
  console.log('local_asr_ready')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    server.close()
    server.closeAllConnections()
    await native.close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
}

if (!isMainThread) await nativeWorker()
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) {
    console.error(typeof error?.code === 'string' && /^asr_[a-z_]{2,40}$/u.test(error.code)
      ? error.code : 'asr_start_failed')
    process.exitCode = 1
  }
}
