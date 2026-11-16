/**
 * 宿主补丁：把 dsh-tui 的两处限制修好，让插件皮肤从启动首帧就生效。
 *
 * ## 为什么要改宿主文件
 *
 * dsh-tui 的启动链（host-entry.js）是：
 *
 *   await apply(ctx, config, ...)      // ① TUI 模块加载 + render() 画首帧
 *   await slot.firstFrameFlushed?.()   // ② 首帧已到达终端
 *   await root.compose(...)            // ③ 插件行在这里才 apply()
 *
 * 本插件的代码是 ③ 才加载的，而内置宠物在 ① 就已经画出来了 —— 插件在架构上
 * 没有「首帧之前」的执行机会。另外两处白名单也写死了三个内置皮肤：
 *
 *   tuiDisplayPrefs.js  COMPANION_SKIN_IDS = ['deepy','whaleGirl','whale']
 *   SplashMascot.js     id === 'deepy' || id === 'whaleGirl' ? id : undefined
 *
 * 所以要在宿主侧补两处：
 *
 *   补丁 A（SplashMascot.js）—— 启动页吉祥物白名单改查注册表
 *   补丁 B（host-entry.js）—— apply() 之前预注册插件皮肤
 *
 * ## 幂等
 *
 * 两个补丁都按「标记串是否存在」判断，重复执行无副作用。写入前会备份原件
 * 到包根旁的 .dsh-tui-pet-patches/，并校验备份是否对应当前宿主版本。
 *
 * ## 失败无害
 *
 * 所有函数只返回结果对象，不抛异常给调用方 —— 补丁是「消除闪烁」的优化，
 * 永远不该成为「启动失败」的原因。
 *
 * @module dsh-tui-elysia-pet/host-patch
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 补丁 B 的标记串（用于幂等判断）。 */
export const ENTRY_MARKER = '首帧前预注册 companion 皮肤（插件补丁 · host-entry 版）'

/** 补丁 A 的各处标记。 */
const SPLASH_WHITELIST_MARK = 'resolveCompanionSkin(id)'
const SPLASH_DISPATCH_MARK = 'children: resolveCompanionSkin(skin).render(input)'

/** host-entry.js 里 apply() 调用的锚点（补丁 B 插在它前面）。 */
const APPLY_ANCHOR = '        await apply(ctx, config, ctx, { deferBackendOpen: true, profile, entryKernel: kernel, exitSeam, ...(slot === undefined ? {} : { entrySlot: slot }) });'

/** SplashMascot.js 原版白名单（补丁 A-2 替换的目标）。 */
const SPLASH_OLD_WHITELIST = [
  '    const id = pinned ?? setting;',
  "    return id === 'deepy' || id === 'whaleGirl' ? id : undefined;",
].join('\n')

/** 替换后的白名单：内置两个 + 注册表里查得到的插件皮肤。 */
const SPLASH_NEW_WHITELIST = [
  '    const id = pinned ?? setting;',
  "    if (id === 'deepy' || id === 'whaleGirl')",
  '        return id;',
  '    // 插件皮肤（经 registerCompanionSkin 注册）同样可以当启动页吉祥物：',
  '    // resolveCompanionSkin 查注册表，命中且不是内置三个之一就认它。',
  '    // 未知 id 会回落到 DeepySkin，所以要排除掉，否则任何非法值都会变成吉祥物。',
  "    if (id !== undefined && id !== 'whale') {",
  '        const skin = resolveCompanionSkin(id);',
  '        if (skin !== undefined && skin.id === id)',
  '            return id;',
  '    }',
  '    return undefined;',
].join('\n')

/** SplashMascot.js 原版分发三元式（补丁 A-3 替换的目标）。 */
const SPLASH_OLD_DISPATCH = "children: skin === 'deepy' ? DeepySkin.render(input) : WhaleGirlSkin.render(input) }) }));"
const SPLASH_NEW_DISPATCH = 'children: resolveCompanionSkin(skin).render(input) }) }));'

/**
 * 定位宿主各文件。
 * @param {string} hostRoot - @deepseek-harness-tui/dsh-tui 包根。
 * @returns {{ splash: string, entry: string, types: string }}
 */
function hostPaths(hostRoot) {
  const types = join(hostRoot, 'lib', 'types')
  return {
    types,
    splash: join(types, 'components', 'sidePanel', 'companion', 'SplashMascot.js'),
    entry: join(types, 'dsh-adapter', 'host-entry.js'),
  }
}

/**
 * 读补丁状态，不写任何文件。
 * @param {string} hostRoot - 包根。
 * @returns {object} 各补丁的完成情况。
 */
export function inspectHost(hostRoot) {
  const { splash, entry } = hostPaths(hostRoot)
  const result = {
    splash: { whitelist: false, dispatch: false, imported: false },
    entry: false,
    patched: false,
    missing: [],
  }

  if (!existsSync(splash)) {
    result.missing.push(splash)
  } else {
    const c = readFileSync(splash, 'utf8')
    result.splash.whitelist = c.includes(SPLASH_WHITELIST_MARK)
    result.splash.dispatch = c.includes(SPLASH_DISPATCH_MARK)
    const imp = c.split('\n').find((l) => /skins\.js/.test(l) && /^\s*import/.test(l))
    result.splash.imported = imp !== undefined && imp.includes('resolveCompanionSkin')
  }

  if (!existsSync(entry)) {
    result.missing.push(entry)
  } else {
    result.entry = readFileSync(entry, 'utf8').includes(ENTRY_MARKER)
  }

  result.patched =
    result.splash.whitelist &&
    result.splash.dispatch &&
    result.splash.imported &&
    result.entry
  return result
}

/**
 * 备份原件（每个文件只留一份；备份对应旧版宿主时不覆盖新版）。
 * @param {string} hostRoot - 包根。
 * @param {string} file - 要备份的文件。
 * @param {string} tag - 备份文件名（不含扩展名）。
 */
function backupOnce(hostRoot, file, tag) {
  const dir = join(dirname(hostRoot), '.dsh-tui-pet-patches')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const bak = join(dir, tag + '.orig')
  const current = readFileSync(file, 'utf8')
  let stale = false
  if (existsSync(bak)) {
    try {
      stale = readFileSync(bak, 'utf8').length < current.length * 0.9
    } catch {
      stale = true
    }
  }
  if (!existsSync(bak) || stale) {
    try {
      copyFileSync(file, bak)
    } catch {
      /* 备份失败不阻断打补丁 */
    }
  }
}

/**
 * 应用补丁 A：启动页吉祥物白名单改为查注册表。
 * @param {string} hostRoot - 包根。
 * @returns {string[]} 实际完成的步骤，用于日志。
 */
function applySplashPatch(hostRoot) {
  const { splash } = hostPaths(hostRoot)
  const done = []
  if (!existsSync(splash)) return done
  backupOnce(hostRoot, splash, 'SplashMascot')

  let c = readFileSync(splash, 'utf8')
  const before = c

  // A-1：import 里补 resolveCompanionSkin
  // 判定看 import 行本身 —— 不能用 SPLASH_WHITELIST_MARK，那是白名单函数里的
  // 标记，打了 A-2 之后它就一直为真，A-1 会被误跳过。
  {
    const lines = c.split('\n')
    const idx = lines.findIndex((l) => /skins\.js/.test(l) && /^\s*import/.test(l))
    if (idx >= 0 && !lines[idx].includes('resolveCompanionSkin')) {
      const close = lines[idx].lastIndexOf('}')
      if (close > 0) {
        lines[idx] = lines[idx].slice(0, close) + ', resolveCompanionSkin' + lines[idx].slice(close)
        c = lines.join('\n')
        done.push('A-1 import')
      }
    }
  }

  // A-2：白名单
  if (c.includes(SPLASH_OLD_WHITELIST)) {
    c = c.replace(SPLASH_OLD_WHITELIST, () => SPLASH_NEW_WHITELIST)
    done.push('A-2 whitelist')
  }

  // A-3：分发
  if (c.includes(SPLASH_OLD_DISPATCH)) {
    c = c.replace(SPLASH_OLD_DISPATCH, () => SPLASH_NEW_DISPATCH)
    done.push('A-3 dispatch')
  }

  if (c !== before) {
    try {
      writeFileSync(splash, c, 'utf8')
    } catch {
      /* 只读文件等 —— 静默放弃 */
    }
  }
  return done
}

/**
 * 应用补丁 B：在 host-entry.js 的 apply() 之前插入预注册块。
 * @param {string} hostRoot - 包根。
 * @returns {string[]} 实际完成的步骤。
 */
function applyEntryPatch(hostRoot) {
  const { entry } = hostPaths(hostRoot)
  const done = []
  if (!existsSync(entry)) return done

  let c = readFileSync(entry, 'utf8')
  if (c.includes(ENTRY_MARKER)) return done   // 已打过

  if (!c.includes(APPLY_ANCHOR)) return done  // 宿主改了实现，跳过

  // 补丁块与 scripts/host-entry-patch.js 同仓
  let block
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    block = readFileSync(join(here, '..', 'scripts', 'host-entry-patch.js'), 'utf8').replace(/\s+$/, '')
  } catch {
    return done
  }
  if (!block.includes(ENTRY_MARKER)) return done

  backupOnce(hostRoot, entry, 'host-entry')
  c = c.replace(APPLY_ANCHOR, () => block + '\n' + APPLY_ANCHOR)
  try {
    writeFileSync(entry, c, 'utf8')
    done.push('B entry')
  } catch {
    /* 静默放弃 */
  }
  return done
}

/**
 * 检测并按需打补丁。幂等：已打过则立即返回。
 *
 * 绝不抛异常 —— 补丁失败只意味着「首帧会闪一下」，不该影响插件正常工作。
 *
 * @param {string} hostRoot - @deepseek-harness-tui/dsh-tui 的包根。
 * @returns {{ patched: boolean, changed: boolean, steps: string[], reason?: string }}
 */
export function ensureHostPatched(hostRoot) {
  const state = inspectHost(hostRoot)
  if (state.patched) return { patched: true, changed: false, steps: [] }

  if (state.missing.length > 0) {
    return {
      patched: false,
      changed: false,
      steps: [],
      reason: '宿主文件缺失：' + state.missing.join(', '),
    }
  }

  const steps = []
  if (!(state.splash.whitelist && state.splash.dispatch && state.splash.imported)) {
    steps.push(...applySplashPatch(hostRoot))
  }
  if (!state.entry) {
    steps.push(...applyEntryPatch(hostRoot))
  }

  const after = inspectHost(hostRoot)
  const outcome = { patched: after.patched, changed: steps.length > 0, steps }
  if (!after.patched) {
    outcome.reason = '宿主结构与补丁锚点不匹配（dsh-tui 可能改了实现）'
  }
  return outcome
}
