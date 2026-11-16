#!/usr/bin/env node
/**
 * 安装钩子：检测并给宿主打补丁。
 *
 * 通过 npm/pnpm 正常安装时由 `postinstall` 调用；也可手动执行：
 *
 *   node node_modules/dsh-tui-elysia-pet/scripts/install.mjs
 *
 * ## 为什么需要
 *
 * dsh-tui 在首帧之后才加载插件，且启动页白名单写死了三个内置皮肤。
 * 插件在宿主侧补两处（详见 lib/host-patch.js），补完首帧起就是爱莉。
 *
 * ## 为什么安装时也要跑一次
 *
 * 插件自己 apply() 时也会自愈，但那已经是「本次启动的首帧画完之后」——
 * 装完第一次启动仍会闪一下。安装时先补好，首次启动就干净。
 *
 * ## 失败不阻断安装
 *
 * 路径找不到（比如在别的 profile 里装）、宿主结构不匹配、文件只读……
 * 一律只打印提示并以 0 退出：补丁是「消除闪烁」的优化，装不上插件也要能装。
 *
 * @module dsh-tui-elysia-pet/scripts/install
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHostPatched, inspectHost } from '../lib/host-patch.js'

/** 找到 dsh-tui 包根。三级回退，与 lib/index.js 的 resolveHostRoot 一致。 */
function findHostRoot() {
  const rel = join('node_modules', '@deepseek-harness-tui', 'dsh-tui')
  const at = (dir) => {
    if (dir === undefined || dir === '') return undefined
    const root = join(dir, rel)
    return existsSync(join(root, 'package.json')) ? root : undefined
  }

  // 1. 从 argv[1] 向上找（pnpm 的嵌套布局）
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    let dir = argv1
    for (let i = 0; i < 14; i++) {
      const slash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (slash <= 0) break
      dir = dir.slice(0, slash)
      const hit = at(dir)
      if (hit !== undefined) return hit
    }
  }

  // 2. $DSH_HOME/profiles/$DSH_PROFILE/node_modules/...
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') {
    const prof = process.env.DSH_PROFILE ?? 'dsh-tui'
    const hit = at(join(home, 'profiles', prof))
    if (hit !== undefined) return hit
  }

  return undefined
}

const root = findHostRoot()
if (root === undefined) {
  console.log('[elysia-pet] 未找到 dsh-tui 包根，跳过宿主补丁。')
  console.log('[elysia-pet] 启动后插件会自行重试；也可手动运行 patch-dsh-tui-host.ps1。')
  process.exit(0)
}

console.log('[elysia-pet] dsh-tui 包根：' + root)
const state = inspectHost(root)
if (state.patched) {
  console.log('[elysia-pet] 宿主补丁已就位，无需操作。')
  process.exit(0)
}

try {
  const hp = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  console.log('[elysia-pet] dsh-tui 版本：' + hp.version)
} catch {}

const outcome = ensureHostPatched(root)
if (outcome.patched) {
  console.log('[elysia-pet] 已打补丁：' + outcome.steps.join(', '))
  console.log('[elysia-pet] 启动 dsh-TUI 后，首帧起就是爱莉，不再闪内置宠物。')
} else {
  console.log('[elysia-pet] 补丁未完成：' + (outcome.reason ?? '未知原因'))
  console.log('[elysia-pet] 插件本身仍可用（侧栏是爱莉，但启动首帧会闪一下）。')
}
process.exit(0)
