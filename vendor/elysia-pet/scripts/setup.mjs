#!/usr/bin/env node
/**
 * 一键安装 dsh-tui-elysia-pet 到当前 dsh-TUI profile。
 *
 * 用法（在任意目录）：
 *
 *   npx -y github:TriSeTide/dsh-tui-elysia-pet
 *
 * 或本地源码：
 *
 *   node <repo>/scripts/setup.mjs
 *
 * 做的事：
 *   1. 定位 DSH_HOME 与 profile
 *   2. 把插件挂进 profile 的 node_modules（junction / symlink）
 *   3. 写 profile 的 cordis.patch.yml 行 + companion.skin
 *   4. 给宿主打补丁（首帧即爱莉）
 *
 * 全程幂等：重复跑不会出问题。每一步失败都给出可执行的修复提示。
 *
 * @module dsh-tui-elysia-pet/scripts/setup
 */
import { existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureHostPatched } from '../lib/host-patch.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const say = (s) => console.log(s)
const ok = (s) => console.log('  OK   ' + s)
const no = (s) => console.log('  FAIL ' + s)
const info = (s) => console.log('  -    ' + s)

/** 找 DSH_HOME：环境变量优先，否则常见位置。 */
function findDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return resolve(fromEnv)

  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const cands = []

  // 1. 用户主目录下的 .dsh（官方默认位置）
  if (home !== '') cands.push(join(home, '.dsh'))

  // 2. 从本脚本位置向上找：仓库可能就在某个 dsh home 里面
  let dir = REPO
  for (let i = 0; i < 8; i++) {
    cands.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. 当前工作目录向上
  dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    cands.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const c of cands) {
    // 两种布局都认：
    //   <home>/profiles/<name>   （标准 DSH_HOME）
    //   <home>/<name>            （扁平布局）
    if (existsSync(join(c, 'profiles')) || existsSync(join(c, 'dsh-tui'))) return resolve(c)
  }
  return undefined
}

say('')
say('=== dsh-tui-elysia-pet installer ===')
say('')

const dshHome = findDshHome()
if (dshHome === undefined) {
  no('Cannot find DSH_HOME.')
  info('Set DSH_HOME to your dsh install root, then rerun.')
  process.exit(1)
}
ok('DSH_HOME = ' + dshHome)

const profileName = process.env.DSH_PROFILE ?? 'dsh-tui'
const profileCands = [
  join(dshHome, 'profiles', profileName),   // 标准布局
  join(dshHome, profileName),               // 扁平布局
]
const profileDir = profileCands.find((p) => existsSync(p))
if (profileDir === undefined) {
  no('Profile not found. Tried:')
  for (const p of profileCands) info('  ' + p)
  info('Run dsh-TUI once to initialize it, then rerun this script.')
  process.exit(1)
}
ok('profile = ' + profileName)

// 1. mount plugin
say('')
say('[1/4] Mount plugin')
const nm = join(profileDir, 'node_modules')
const target = join(nm, 'dsh-tui-elysia-pet')

if (!existsSync(nm)) {
  no('profile node_modules missing; run dsh-TUI once first.')
  process.exit(1)
}

let linked = false
if (existsSync(target)) {
  const st = lstatSync(target)
  if (st.isSymbolicLink() || st.isDirectory()) {
    ok('already mounted: ' + target)
    linked = true
  }
}
if (!linked) {
  try {
    symlinkSync(REPO, target, process.platform === 'win32' ? 'junction' : 'dir')
    ok('mounted: ' + target)
    info('-> ' + REPO)
  } catch (e) {
    no('mount failed: ' + String(e.message))
    info('manual: cmd /c mklink /J "' + target + '" "' + REPO + '"')
  }
}

// 2. cordis.patch.yml
say('')
say('[2/4] Configure profile')
const ymlPath = join(profileDir, 'cordis.patch.yml')
const ROW_ID = 'dsh-tui-elysia-pet'

if (!existsSync(ymlPath)) writeFileSync(ymlPath, '', 'utf8')
let yml = readFileSync(ymlPath, 'utf8')

if (!yml.includes('id: ' + ROW_ID)) {
  const row = [
    '',
    '- id: ' + ROW_ID,
    '  config:',
    '    splashAnimation: drag',
    '    activateOnLoad: true',
  ].join('\n')
  yml = yml.replace(/\s*$/, '') + row + '\n'
  ok('plugin row added')
} else {
  ok('plugin row present')
}

if (!/companion:\s*\n\s+skin:/.test(yml)) {
  const lines = yml.split('\n')
  const idx = lines.findIndex((l) => /^-\s+id:\s*dsh-tui\s*$/.test(l))
  if (idx >= 0) {
    let end = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^- /.test(lines[i])) { end = i; break }
    }
    lines.splice(end, 0, '    companion:', '      skin: elysia')
    yml = lines.join('\n')
    ok('companion.skin = elysia')
  } else {
    info('no dsh-tui row yet; first launch creates it, rerun then')
  }
} else {
  ok('companion.skin already set')
}
writeFileSync(ymlPath, yml, 'utf8')

// 3. bundles
say('')
say('[3/4] Check bundle order')
const pkgPath = join(profileDir, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  // 有些 profile 不写 bundles（全靠 cordis.patch.yml），这时也要补上
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []

  const pi = bundles.indexOf(ROW_ID)
  const ti = bundles.indexOf('@deepseek-harness-tui/dsh-tui')
  if (pi < 0) {
    const at = ti >= 0 ? ti : bundles.length
    bundles.splice(at, 0, ROW_ID)
    ok('bundles: inserted before dsh-tui')
  } else if (ti >= 0 && pi > ti) {
    bundles.splice(pi, 1)
    bundles.splice(ti, 0, ROW_ID)
    ok('bundles: moved before dsh-tui')
  } else {
    ok('bundles: order correct')
  }
  pkg.dsh.profile.bundles = bundles
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

// 4. host patch
say('')
say('[4/4] Host patch')
const hostRoot = join(nm, '@deepseek-harness-tui', 'dsh-tui')
if (!existsSync(join(hostRoot, 'package.json'))) {
  info('dsh-tui host package not found; plugin will retry at startup')
} else {
  // 先报宿主版本，方便用户贴日志求助
  try {
    const hp = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8'))
    info('dsh-tui ' + hp.version)
  } catch {}

  try {
    const r = ensureHostPatched(hostRoot)
    if (r.patched) {
      if (r.changed) ok('patched: ' + r.steps.join(', '))
      else ok('patch already in place')
    } else {
      info('patch incomplete: ' + (r.reason ?? 'unknown'))
      info('plugin still works; first frame may flash')
      info('host version differs from tested (0.15.x / 0.16.1 / 0.20.0);')
      info('please open an issue with the line above')
    }
  } catch (e) {
    info('patch error: ' + String(e.message))
  }
}

say('')
say('=== done ===')
say('')
ok('restart dsh-TUI (/reload does not reload plugin code)')
ok('then /settings -> 宠物皮肤 -> 爱莉')
say('')
