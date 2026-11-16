/**
 * dsh-tui-elysia-pet —— 把爱莉像素桌宠作为**新皮肤**加进 dsh-TUI 的
 * companion 面板，与内置的 deepy / 鲸娘 / 像素鲸鱼并列，在
 * **\`/settings\` → 外观与布局 → 宠物皮肤** 里选择。
 *
 * ## 为什么不是"覆盖内置皮肤"
 *
 * 覆盖（把 whaleGirl 换成爱莉）能跑，但设置列表里那一项仍叫「Whale girl」，
 * 用户看不到"爱莉"这个名字。正确做法是**新增一个 id 并同时写进两处注册表**：
 *
 * - `skins` Map（皮肤本体）—— `registerCompanionSkin`
 * - `COMPANION_SKIN_IDS`（normalize 白名单，不在里面会被静默回落成 deepy）
 *   与 `settings/definitions.js` 的 `companion.skin.options`（决定列表里有什么）
 *
 * 三处都是普通可变数组/Map，实测可运行时追加。
 *
 * ## 渲染
 *
 * 走宿主自己的半块精灵管线 `renderSpriteRows`（`Whale.js` 导出）：它把
 * 上下两个像素编进一个 `▀` 字符（上像素前景、下像素背景），所以 32×16 的帧
 * 只输出 8 行、每行一个含 ANSI 转义码的字符串。宿主内置的像素鲸鱼走的就是
 * 这条路 —— 自己手写逐像素 Text 会渲染错乱（已踩过）。
 *
 * @module dsh-tui-elysia-pet
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveConfig } from './config.js'
import { loadKit } from './frames.js'
import { createResolver } from './animations.js'
import { createSkin, setHostDeps, setAnimationResolver, setPngDecoder, decodeAnimation } from './skin.js'
import { appendSkinId, appendSettingOption, activateSkin } from './register.js'
import { ensureHostPatched, inspectHost } from './host-patch.js'

export const name = 'dsh-tui-elysia-pet'

/** 不声明 inject：皮肤与设置项都是模块级注册表，不是 Cordis 服务。 */
export const inject = []

/**
 * 定位宿主的 dsh-tui 包根目录。
 *
 * **不能用 \`createRequire(import.meta.url)\`**：Node 的 ESM 解析默认把模块路径
 * realpath 化，插件经 junction 安装时 \`import.meta.url\` 会变成开发目录，从那里
 * 向上找不到任何 \`node_modules\`，解析必然失败 —— 且是静默失败（只 warn 一次），
 * 表现为"插件装了但没效果"。
 *
 * 三级策略，从最可靠到兜底：
 * 1. \`process.argv[1]\`（宿主启动器真实路径，不受 realpath 影响）向上逐层找；
 * 2. 以它为基准交给 Node 解析器（吃 pnpm 的嵌套 node_modules 布局）；
 * 3. \`$DSH_HOME/profiles/$DSH_PROFILE/node_modules/...\`（标准 profile 布局）。
 */
function resolveHostRoot() {
  const rel = join('node_modules', '@deepseek-harness-tui', 'dsh-tui')
  const hostRootAt = (dir) => {
    if (dir === undefined) return undefined
    const root = join(dir, rel)
    return existsSync(join(root, 'package.json')) ? root : undefined
  }

  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    let dir = dirname(argv1)
    for (let depth = 0; depth < 12; depth++) {
      const hit = hostRootAt(dir)
      if (hit !== undefined) return hit
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    try {
      return dirname(createRequire(pathToFileURL(argv1)).resolve('@deepseek-harness-tui/dsh-tui/package.json'))
    } catch {
      // 落到策略 3
    }
  }

  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home !== '') {
    const hit = hostRootAt(join(home, 'profiles', typeof profile === 'string' && profile !== '' ? profile : 'default'))
    if (hit !== undefined) return hit
  }
  return undefined
}

// ── 模块加载即注册白名单 ────────────────────────────────────────────────
//
// 宿主保存设置时会把 companion.skin 过一遍 normalizeCompanionSkin，白名单里
// 没有的 id 一律回落 deepy。而插件原来的注册发生在 apply() 里 —— 那已经是
// TUI 起来之后。结果：
//
//   用户在设置里点「爱莉」→ 保存 → normalize 不认识 elysia → 落回 deepy
//   → 界面刷新后那一项变回别的，看起来「点了就没了」
//
// 所以白名单必须在**插件模块被 import 的那一刻**就追加。模块求值时机早于
// 任何设置读写，注册完整之后 normalize 才认得这个 id。
//
// 这里只追加白名单（一个字符串进数组），不构造皮肤对象：皮肤要等 apply()
// 拿到宿主依赖（React / ui / hooks）才能建。设置项选项表同理，要 apply()
// 里用真实 definitions 模块追加 —— 但白名单是纯数据，越早越好。
//
// 失败静默：宿主结构不对时不注册，插件本身仍会在 apply() 里再试一次。
try {
  const __earlyRoot = resolveHostRoot()
  if (__earlyRoot !== undefined) {
    const __types = join(__earlyRoot, 'lib', 'types')

    // ① 白名单：保存设置时的 normalize 靠它认这个 id
    const __earlyPrefs = await import(pathToFileURL(join(__types, 'tuiDisplayPrefs.js')).href)
    const __ids = __earlyPrefs.COMPANION_SKIN_IDS
    if (Array.isArray(__ids) && !__ids.includes('elysia')) __ids.push('elysia')

    // ② 选项表：设置界面按它决定列表里有什么、以及 cycleField 的索引基准。
    // 少这项时，界面上看不到「爱莉」；即便通过别的方式选中，cycleField 的
    // findIndex 也会返回 -1 → 每次点击都跳回 options[0]（deepy），表现为
    // 「点一下就没了」。
    const __earlyDefs = await import(pathToFileURL(join(__types, 'settings', 'definitions.js')).href)
    const __options = __earlyDefs.SETTING_DEFINITIONS?.['companion.skin']?.options
    if (Array.isArray(__options) && !__options.some((o) => o?.value === 'elysia')) {
      __options.push({ value: 'elysia', label: 'Elysia', descriptions: { zh: '爱莉' } })
    }
  }
} catch {
  /* 宿主结构不符时留给 apply() 重试 */
}


/**
 * 挂载。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const root = resolveHostRoot()
  if (root === undefined) {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 找不到 @deepseek-harness-tui/dsh-tui，皮肤未注册')
    return
  }

  // ── 宿主补丁自愈 ──────────────────────────────────────────────────────
  //
  // dsh-tui 的启动顺序决定了插件没有「首帧之前」的执行机会：
  //
  //   await apply(...)                 // 首帧在这里就画完了
  //   await slot.firstFrameFlushed?.()
  //   await root.compose(...)          // 插件 apply() 在这里才开始跑
  //
  // 所以本次启动看到的内置宠物已经改不了了；这里能做的只是**把宿主文件补好**，
  // 让**下次启动**干净。dsh-tui 升级会覆盖 node_modules，这块自愈就是为那之后
  // 的第一次启动准备的 —— 补完之后第二次起就不闪。
  //
  // 幂等：已打过则只做一次 stat 级检查。失败不影响插件本身（皮肤照常注册，
  // 只是下次启动还会闪一下），所以整段包在 try 里、异常只 warn。
  try {
    const outcome = ensureHostPatched(root)
    if (outcome.changed) {
      ctx.logger?.info?.(
        'dsh-tui-elysia-pet: 已自动给宿主打补丁（' + outcome.steps.join(', ') + '）。' +
          '本次启动仍会用内置宠物作首帧，下次启动起生效。',
      )
    } else if (!outcome.patched && outcome.reason !== undefined) {
      ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主补丁未生效 —— ' + outcome.reason)
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主补丁自愈失败 —— ' + String(error?.message ?? error))
  }

  const types = join(root, 'lib', 'types')
  const paths = {
    skins: join(types, 'components', 'sidePanel', 'companion', 'skins.js'),
    whale: join(types, 'components', 'Whale.js'),
    ui: join(types, 'ui.js'),
    prefs: join(types, 'tuiDisplayPrefs.js'),
    definitions: join(types, 'settings', 'definitions.js'),
    // 图像协议轨：hooks 在 ink/hooks 下，sharp 封装在 dsh-adapter 下。
    imageHooks: join(types, 'ink', 'hooks', 'use-terminal-images.js'),
    // 侧栏运行时上下文：拿 channel 明细消解 music 歧义（skin.js 用）。
    sidePanelContext: join(types, 'components', 'sidePanel', 'SidePanelRuntimeContext.js'),
    sharp: join(types, 'dsh-adapter', 'sharp.js'),
  }
  for (const [what, p] of Object.entries(paths)) {
    if (!existsSync(p)) {
      ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主缺少 ' + what + '（' + p + '），皮肤未注册')
      return
    }
  }

  // React 从宿主位置解析：插件自己的物理路径未必在宿主的 node_modules 链上。
  const req = createRequire(pathToFileURL(join(root, 'package.json')))
  let React
  try {
    React = req('react')
  } catch (error) {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 解析不到 react —— ' + String(error?.message ?? error))
    return
  }

  let mods
  try {
    mods = {
      skins: await import(pathToFileURL(paths.skins).href),
      whale: await import(pathToFileURL(paths.whale).href),
      ui: await import(pathToFileURL(paths.ui).href),
      prefs: await import(pathToFileURL(paths.prefs).href),
      definitions: await import(pathToFileURL(paths.definitions).href),
      imageHooks: await import(pathToFileURL(paths.imageHooks).href),
      sidePanelContext: await import(pathToFileURL(paths.sidePanelContext).href),
      sharp: await import(pathToFileURL(paths.sharp).href),
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 导入宿主模块失败 —— ' + String(error?.message ?? error))
    return
  }

  if (typeof mods.skins.registerCompanionSkin !== 'function') {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主未提供 registerCompanionSkin，皮肤未注册')
    return
  }
  if (typeof mods.whale.renderSpriteRows !== 'function') {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主未导出 renderSpriteRows，皮肤未注册')
    return
  }

  const kit = loadKit()
  if (kit === undefined) {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: assets/letters.json 缺失或校验失败，皮肤未注册')
    return
  }

  // 资产目录：lib/ 的上一级。必须在下面的 resolver 之前定义 —— const 有暂时性
  // 死区，函数体里引用它时若尚未执行到那一行会抛 ReferenceError。
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

  setHostDeps({
    Box: mods.ui.Box,
    Text: mods.ui.Text,
    Image: mods.ui.Image,
    renderSpriteRows: mods.whale.renderSpriteRows,
    useTerminalImages: mods.imageHooks.useTerminalImages,
    useTerminalImageProtocol: mods.imageHooks.useTerminalImageProtocol,
    useSidePanelChannel: mods.sidePanelContext.useSidePanelChannel,
  })

  // 图像轨：动画键 → 该动画每帧 PNG 的绝对路径（构建脚本产出）。
  setAnimationResolver((key) => {
    const anim = kit.animations.get(key)
    if (anim === undefined) return undefined
    const dir = join(assetsDir, 'img', key)
    if (!existsSync(dir)) return undefined
    return {
      frames: anim.frames.map((f, i) => ({ dur: f.dur, file: join(dir, String(i).padStart(2, '0') + '.png') })),
    }
  })

  // 用宿主自己的 sharp 解码 PNG（插件保持零依赖）。放大用最近邻 —— 像素画
  // 绝不能用插值核，否则边缘糊成渐变。
  const loadSharp = mods.sharp.loadSharp ?? mods.sharp.default ?? undefined
  if (typeof loadSharp === 'function') {
    setPngDecoder(async (file, requested) => {
      const sharp = await loadSharp()
      const image = sharp(file)
      const meta = await image.metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      if (w <= 0 || h <= 0) throw new Error('读不到 PNG 尺寸: ' + file)
      // 宿主 isTerminalImageSource 的硬上限：边长 <= 1024，字节 <= 4MiB
      // （即 w*h*4 <= 4194304，等价于 w*h <= 1024*1024）。请求的倍率先钳到
      // 这两个约束内 —— 超了 Image 会整帧拒绝，桌宠直接不显示。
      const MAX_EDGE = 1024
      const MAX_PIXELS = 1024 * 1024
      const byEdge = Math.min(MAX_EDGE / w, MAX_EDGE / h)
      const byPixels = Math.sqrt(MAX_PIXELS / (w * h))
      const scale = Math.max(1, Math.floor(Math.min(requested, byEdge, byPixels)))
      const target = scale === 1
        ? image
        : image.resize(w * scale, h * scale, { kernel: 'nearest' })
      // 像素画放大必须最近邻：插值核会把色块边缘糊成渐变，爱莉就成一团粉色了。
      const { data, info } = await target.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      return { data: new Uint8Array(data), width: info.width, height: info.height }
    })
  }

  const resolver = createResolver(kit.animations, config)
  const skin = createSkin({ React, kit, resolver, config })
  mods.skins.registerCompanionSkin(skin)

  // 关键两步：不追加白名单，选中后会被 normalizeCompanionSkin 静默回落成 deepy；
  // 不追加设置项，列表里不会出现这个名字。
  const whitelist = appendSkinId(mods.prefs, config.skinId)
  const option = appendSettingOption(mods.definitions.SETTING_DEFINITIONS, config.skinId, config.title, config.description)

  if (whitelist === 'unsupported' || option === 'unsupported') {
    ctx.logger?.warn?.('dsh-tui-elysia-pet: 宿主注册表结构不符合预期（白名单 ' + whitelist + '，选项 ' + option + '），爱莉可能不出现在设置里')
  }

  let activated = false
  if (config.activateOnLoad) activated = activateSkin(mods.prefs, config.skinId)

  ctx.logger?.info?.(
    'dsh-tui-elysia-pet: 已在「宠物皮肤」加入 "' + config.title + '"（id=' + config.skinId +
    '，白名单 ' + whitelist + '，选项 ' + option + '）' +
    (activated ? '，并已切换过去' : '；到 /settings 选中它即可看到爱莉'),
  )
}
