/**
 * OBS（WebSocket v5，OBS 28+ 自带）：专用的配置文件和场景集合「dsh-livestream」，舞台页当浏览器源，推流到 B 站。
 *
 * 画面清不清楚全看编码设置（以前 OBS 简单模式 x264 veryfast 1.4Mbps 糊过）：
 *   - 画布和输出都是 1920×1080，不缩放；舞台页本来就是 1080p
 *   - NVENC H.264 硬件编码，CBR（B 站要恒定码率，码率是设置，默认 4500 kbps），关键帧 2 秒
 *   - RTMP 开「动态码率」：网络堵的时候降码率，不丢帧（实测日本推到 B 站的 RTMP 只有 3 Mbps 左右，丢了三分之二的帧）
 *   - P6 + 高质量调优 + 两遍编码 + 心理视觉 AQ + 2 个 B 帧：码率花在文字和边缘上
 *   - 30 帧：舞台大部分是静的，同样码率 30 帧比 60 帧清楚
 *   - 声音只要舞台页自己的（浏览器源交给 OBS 控制音频），不要麦克风和桌面音频
 * 只动自己这套配置和场景集合，不碰用户别的 OBS 配置。WebSocket 密码从 OBS 自己的配置里读，不打印。
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OBS_NAME = 'dsh-livestream';
const SCENE = '直播';
const STAGE_SOURCE = '舞台';

const OBS_DIR = join(process.env.APPDATA ?? '', 'obs-studio');
/**
 * OBS 装在哪：环境变量 DSH_LIVESTREAM_OBS（obs64.exe 的完整路径）→ 注册表里安装程序写的目录 → 常见位置。
 * 不同机器装的位置不一样（有的在 D:\Software\obs-studio）
 */
export function findObsExe(): string | null {
  const candidates: string[] = [];
  if (process.env.DSH_LIVESTREAM_OBS) candidates.push(process.env.DSH_LIVESTREAM_OBS);
  for (const key of ['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio', 'HKCU\\SOFTWARE\\OBS Studio']) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const dir = /REG_SZ\s+(.+)/.exec(out)?.[1]?.trim();
      if (dir) candidates.push(join(dir, 'bin', '64bit', 'obs64.exe'));
    } catch {
      // 没有这个键
    }
  }
  candidates.push(
    'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    'D:\\Software\\obs-studio\\bin\\64bit\\obs64.exe',
    'D:\\obs-studio\\bin\\64bit\\obs64.exe',
  );
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** 推流编码设置（写进配置文件目录的 streamEncoder.json） */
const STREAM_ENCODER = {
  rate_control: 'CBR',
  bitrate: 4500,
  keyint_sec: 2,
  preset2: 'p6',
  tune: 'hq',
  multipass: 'qres',
  profile: 'high',
  bf: 2,
  lookahead: false,
  adaptive_quantization: true,
  psycho_aq: true,
};

type Call = <T = any>(requestType: string, requestData?: Record<string, unknown>) => Promise<T>;

export interface Obs {
  call: Call;
  close(): void;
}

function websocketConfig(): { port: number; password: string; enabled: boolean } {
  const file = join(OBS_DIR, 'plugin_config', 'obs-websocket', 'config.json');
  if (!existsSync(file)) return { port: 4455, password: '', enabled: false };
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { server_port?: number; server_password?: string; server_enabled?: boolean; auth_required?: boolean };
  return { port: cfg.server_port ?? 4455, password: cfg.auth_required === false ? '' : cfg.server_password ?? '', enabled: cfg.server_enabled !== false };
}

function connectOnce(): Promise<Obs> {
  const { port, password } = websocketConfig();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map<string, { res: (v: any) => void; rej: (e: Error) => void; requestType: string }>();
    const timer = setTimeout(() => { ws.close(); reject(new Error('连 OBS 超时')); }, 5000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连不上 OBS')); };
    ws.onmessage = (msg) => {
      const { op, d } = JSON.parse(String(msg.data));
      if (op === 0) {
        const identify: Record<string, unknown> = { rpcVersion: 1 };
        if (d.authentication) {
          const secret = createHash('sha256').update(password + d.authentication.salt).digest('base64');
          identify.authentication = createHash('sha256').update(secret + d.authentication.challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (op === 2) {
        clearTimeout(timer);
        resolve({
          call: (requestType, requestData = {}) => {
            const requestId = randomUUID();
            ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
            return new Promise((res, rej) => pending.set(requestId, { res, rej, requestType }));
          },
          close: () => ws.close(),
        });
      } else if (op === 7) {
        const p = pending.get(d.requestId);
        if (!p) return;
        pending.delete(d.requestId);
        if (d.requestStatus.result) p.res(d.responseData ?? {});
        else p.rej(new Error(`OBS ${p.requestType} 失败：${d.requestStatus.code} ${d.requestStatus.comment ?? ''}`));
      }
    };
  });
}

/** 连上 OBS；没开就帮忙打开（WebSocket 服务器要在 OBS 里启用过） */
export async function connectObs(launch = true): Promise<Obs> {
  try {
    return await connectOnce();
  } catch (err) {
    if (!launch) throw err;
    if (!websocketConfig().enabled) throw new Error('OBS 的 WebSocket 服务器没启用：OBS → 工具 → WebSocket 服务器设置 → 启用');
    const exe = findObsExe();
    if (!exe) throw new Error('没找到 OBS：先装 OBS；装在不常见的位置就设环境变量 DSH_LIVESTREAM_OBS（obs64.exe 的完整路径）');
    spawn(exe, ['--disable-shutdown-check', '--disable-updater'], { cwd: join(exe, '..'), detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await connectOnce();
      } catch {
        // OBS 还在启动
      }
    }
    throw new Error('打开了 OBS，但 30 秒内连不上它的 WebSocket');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 配置文件的目录：OBS 按名字生成目录名（会去掉「-」之类的字符，dsh-livestream → dshlivestream），
 * 所以按 basic.ini 里的 Name= 找，不猜目录名
 */
function profileDir(name: string): string | null {
  const root = join(OBS_DIR, 'basic', 'profiles');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const ini = join(root, dir, 'basic.ini');
    if (existsSync(ini) && /^Name=(.*)$/m.exec(readFileSync(ini, 'utf8').replace(/^\uFEFF/, ''))?.[1]?.trim() === name) return join(root, dir);
  }
  return null;
}

/** 切到自己的配置文件和场景集合，设好画质；舞台页当浏览器源 */
export async function prepareObs(obs: Obs, stageUrl: string, kbps = STREAM_ENCODER.bitrate): Promise<void> {
  // 配置文件：画质、声音
  const { profiles, currentProfileName } = await obs.call<{ profiles: string[]; currentProfileName: string }>('GetProfileList');
  if (!profiles.includes(OBS_NAME)) await obs.call('CreateProfile', { profileName: OBS_NAME });
  else if (currentProfileName !== OBS_NAME) await obs.call('SetCurrentProfile', { profileName: OBS_NAME });
  await sleep(800);
  const params: Array<[string, string, string]> = [
    ['Output', 'Mode', 'Advanced'],
    ['AdvOut', 'Encoder', 'obs_nvenc_h264_tex'],
    ['AdvOut', 'UseRescale', 'false'],
    ['AdvOut', 'TrackIndex', '1'],
    ['AdvOut', 'Track1Bitrate', '192'],
    ['AdvOut', 'ApplyServiceSettings', 'true'],
    ['Audio', 'SampleRate', '48000'],
    ['Audio', 'ChannelSetup', 'Stereo'],
    ['Output', 'Reconnect', 'true'],
    ['Output', 'RetryDelay', '2'],
    ['Output', 'MaxRetries', '25'],
    // 网络堵的时候降码率而不是丢帧（只对 RTMP 生效）
    ['Output', 'DynamicBitrate', 'true'],
  ];
  for (const [parameterCategory, parameterName, parameterValue] of params) {
    await obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
  }
  await obs.call('SetVideoSettings', { fpsNumerator: 30, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 });
  // 编码器参数在配置文件目录的 streamEncoder.json 里：写好后切走再切回来，让 OBS 重新读
  const dir = profileDir(OBS_NAME);
  if (!dir) throw new Error('找不到 OBS 的 dsh-livestream 配置文件目录');
  const file = join(dir, 'streamEncoder.json');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const wanted = JSON.stringify({ ...STREAM_ENCODER, bitrate: kbps }, null, 1);
  if (current.trim() !== wanted.trim()) {
    writeFileSync(file, wanted);
    const other = profiles.find((p) => p !== OBS_NAME);
    if (other) {
      await obs.call('SetCurrentProfile', { profileName: other });
      await sleep(800);
      await obs.call('SetCurrentProfile', { profileName: OBS_NAME });
      await sleep(800);
    }
  }

  // 场景集合：一个场景，只有舞台页
  const { sceneCollections, currentSceneCollectionName } = await obs.call<{ sceneCollections: string[]; currentSceneCollectionName: string }>('GetSceneCollectionList');
  if (!sceneCollections.includes(OBS_NAME)) await obs.call('CreateSceneCollection', { sceneCollectionName: OBS_NAME });
  else if (currentSceneCollectionName !== OBS_NAME) await obs.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_NAME });
  await sleep(1500);
  const { scenes } = await obs.call<{ scenes: Array<{ sceneName: string }> }>('GetSceneList');
  if (!scenes.some((s) => s.sceneName === SCENE)) await obs.call('CreateScene', { sceneName: SCENE });
  await obs.call('SetCurrentProgramScene', { sceneName: SCENE });
  // 声音只要舞台页的：去掉全局的麦克风和桌面音频
  const special = await obs.call<Record<string, string | null>>('GetSpecialInputs');
  for (const key of ['desktop1', 'desktop2', 'mic1', 'mic2', 'mic3', 'mic4']) {
    if (special[key]) await obs.call('RemoveInput', { inputName: special[key] });
  }
  const stage = {
    url: stageUrl,
    width: 1920,
    height: 1080,
    fps_custom: false,
    reroute_audio: true,
    shutdown: false,
    restart_when_active: false,
    css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
  };
  const { inputs } = await obs.call<{ inputs: Array<{ inputName: string }> }>('GetInputList');
  if (!inputs.some((i) => i.inputName === STAGE_SOURCE)) {
    await obs.call('CreateInput', { sceneName: SCENE, inputName: STAGE_SOURCE, inputKind: 'browser_source', inputSettings: stage });
  } else {
    await obs.call('SetInputSettings', { inputName: STAGE_SOURCE, inputSettings: stage });
  }
  // 舞台铺满画布、声音不回放到本机（不然主人这边会听到两遍）
  const { sceneItemId } = await obs.call<{ sceneItemId: number }>('GetSceneItemId', { sceneName: SCENE, sourceName: STAGE_SOURCE });
  await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' } });
  await obs.call('SetInputAudioMonitorType', { inputName: STAGE_SOURCE, monitorType: 'OBS_MONITORING_TYPE_NONE' });
}

const GAME_WINDOW = '游戏窗口';
const GAME_HUD = '游戏 HUD';
const GAME_AUDIO = '游戏声音';
/** 游戏声音压低一点：她说话、视频声音在前面 */
const GAME_AUDIO_DB = -14;

/**
 * 她在直播里玩的游戏（窗口画面）上舞台：窗口捕获摆在舞台的游戏位上（rect，画布坐标），
 * HUD 网页（透明背景、和窗口一样大）叠在它上面、一样摆；游戏声音用应用程序音频捕获抓同一个窗口。
 * 窗口和 HUD 垫在舞台下面：舞台在游戏位把背景挖空，礼物提醒、特效、字幕照样浮在游戏画面上。null：三个源都拿掉
 */
export async function showGameSources(obs: Obs, game: { window: string; overlay?: string } | null, rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const { inputs } = await obs.call<{ inputs: Array<{ inputName: string }> }>('GetInputList');
  const has = (name: string) => inputs.some((i) => i.inputName === name);
  if (!game) {
    for (const name of [GAME_HUD, GAME_WINDOW, GAME_AUDIO]) if (has(name)) await obs.call('RemoveInput', { inputName: name });
    return;
  }
  const put = async (name: string, kind: string, settings: Record<string, unknown>) => {
    if (has(name)) await obs.call('SetInputSettings', { inputName: name, inputSettings: settings });
    else await obs.call('CreateInput', { sceneName: SCENE, inputName: name, inputKind: kind, inputSettings: settings });
    const { sceneItemId } = await obs.call<{ sceneItemId: number }>('GetSceneItemId', { sceneName: SCENE, sourceName: name });
    return sceneItemId;
  };
  // method 2 = Windows Graphics Capture：窗口被挡住也抓得到；只抓客户区、不要鼠标
  const windowItem = await put(GAME_WINDOW, 'window_capture', { window: game.window, method: 2, client_area: true, cursor: false, compatibility: false });
  const place = {
    positionX: rect.x, positionY: rect.y, alignment: 5,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: rect.w, boundsHeight: rect.h, boundsAlignment: 0,
  };
  await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: windowItem, sceneItemTransform: place });
  await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: windowItem, sceneItemIndex: 0 });
  if (game.overlay) {
    // HUD 网页要和窗口一样大才叠得准：等窗口抓到画面，拿它的原始大小
    let size = { w: 1280, h: 720 };
    for (let i = 0; i < 10; i++) {
      const t = await obs.call<{ sceneItemTransform: { sourceWidth: number; sourceHeight: number } }>('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: windowItem });
      if (t.sceneItemTransform.sourceWidth > 0) {
        size = { w: t.sceneItemTransform.sourceWidth, h: t.sceneItemTransform.sourceHeight };
        break;
      }
      await sleep(500);
    }
    const hudItem = await put(GAME_HUD, 'browser_source', {
      url: game.overlay, width: size.w, height: size.h, fps_custom: false, reroute_audio: false, shutdown: false,
      css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
    });
    await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: hudItem, sceneItemTransform: place });
    await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: hudItem, sceneItemIndex: 1 });
  } else if (has(GAME_HUD)) {
    await obs.call('RemoveInput', { inputName: GAME_HUD });
  }
  await put(GAME_AUDIO, 'wasapi_process_output_capture', { window: game.window, priority: 2 });
  await obs.call('SetInputVolume', { inputName: GAME_AUDIO, inputVolumeDb: GAME_AUDIO_DB });
  await obs.call('SetInputAudioMonitorType', { inputName: GAME_AUDIO, monitorType: 'OBS_MONITORING_TYPE_NONE' });
}

/** 推流到 B 站：写入推流地址和推流码，开始推流，确认真的推上了 */
export async function startStreaming(obs: Obs, addr: string, code: string): Promise<void> {
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server: addr, key: code, use_auth: false, bwtest: false },
  });
  const status = await obs.call<{ outputActive: boolean }>('GetStreamStatus');
  if (!status.outputActive) await obs.call('StartStream');
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if ((await obs.call<{ outputActive: boolean }>('GetStreamStatus')).outputActive) return;
  }
  throw new Error('OBS 没能开始推流（看 OBS 的日志）');
}

/** 检查 OBS：设好配置和场景，返回节目画面的一帧（PNG data URL）和当前设置；不推流 */
export async function checkObs(obs: Obs, stageUrl: string, kbps?: number): Promise<{ image: string; video: unknown; profile: string; collection: string }> {
  await prepareObs(obs, stageUrl, kbps);
  // 等舞台页加载出来
  await sleep(4000);
  const video = await obs.call('GetVideoSettings');
  const { currentProfileName } = await obs.call<{ currentProfileName: string }>('GetProfileList');
  const { currentSceneCollectionName } = await obs.call<{ currentSceneCollectionName: string }>('GetSceneCollectionList');
  const shot = await obs.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'jpg', imageWidth: 960, imageHeight: 540, imageCompressionQuality: 85 });
  return { image: shot.imageData, video, profile: currentProfileName, collection: currentSceneCollectionName };
}

export async function stopStreaming(obs: Obs): Promise<void> {
  const status = await obs.call<{ outputActive: boolean }>('GetStreamStatus');
  if (status.outputActive) await obs.call('StopStream');
}

export interface StreamHealth {
  active: boolean;
  /** 推了多久 */
  timecode: string;
  /** 丢帧（网络） */
  skipped: number;
  total: number;
  /** 渲染延迟、编码延迟的帧 */
  renderSkipped: number;
  outputSkipped: number;
  kbps: number;
}

let lastBytes: { bytes: number; at: number } | null = null;

export async function streamHealth(obs: Obs): Promise<StreamHealth> {
  const s = await obs.call<{ outputActive: boolean; outputTimecode: string; outputSkippedFrames: number; outputTotalFrames: number; outputBytes: number }>('GetStreamStatus');
  const stats = await obs.call<{ renderSkippedFrames: number; outputSkippedFrames: number }>('GetStats');
  const now = Date.now();
  const kbps = lastBytes && s.outputBytes >= lastBytes.bytes ? Math.round(((s.outputBytes - lastBytes.bytes) * 8) / Math.max(1, now - lastBytes.at)) : 0;
  lastBytes = { bytes: s.outputBytes, at: now };
  return { active: s.outputActive, timecode: s.outputTimecode, skipped: s.outputSkippedFrames, total: s.outputTotalFrames, renderSkipped: stats.renderSkippedFrames, outputSkipped: stats.outputSkippedFrames, kbps };
}

/** 直播画面现在的样子（OBS 里「直播」场景，观众看到的同一张）：JPEG */
export async function screenshot(width = 1280, height = 720): Promise<Uint8Array> {
  const obs = await connectObs(false);
  try {
    const shot = await obs.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'jpg', imageWidth: width, imageHeight: height, imageCompressionQuality: 80 });
    return new Uint8Array(Buffer.from(shot.imageData.slice(shot.imageData.indexOf(',') + 1), 'base64'));
  } finally {
    obs.close();
  }
}
