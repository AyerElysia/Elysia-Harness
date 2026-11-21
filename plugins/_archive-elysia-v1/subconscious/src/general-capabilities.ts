import { mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as NativeScheduleTools from '@deepseek-ai/dsh-tool-schedule'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import * as FileCapabilities from '@elysia/conscious-mind/file-capabilities'
import * as SkillCapabilities from '@elysia/conscious-mind/skill-capabilities'
import * as WebCapabilities from '@elysia/conscious-mind/web-capabilities'
import type { Config } from './config.ts'
import { ROUTER_SESSION_ID } from './model.ts'
import { installScheduleGuard } from './schedule-guard.ts'

interface PathArgs { file_path?: unknown }
interface BashArgs { run_in_background?: unknown; sandbox_permissions?: unknown }

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return resolve(path)
  }
}

/** The shared file adapter backs up prompts; Router itself may only read them. */
export async function guardStandingPromptWrites(ctx: Context, config: { baseDir: string; files: string[]; workspaceDir: string }): Promise<void> {
  const promptPaths = new Set<string>()
  for (const file of config.files) {
    const path = resolve(config.baseDir, file)
    promptPaths.add(path)
    promptPaths.add(await canonical(path))
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write' && exec.name !== 'edit') return next()
    const raw = (exec.arguments as PathArgs).file_path
    if (typeof raw !== 'string' || raw.length === 0) return next()
    // Router has one fixed workspace; avoid resolving through an unrelated
    // caller's mutable cwd inside this standing-prompt guard.
    const target = resolve(config.workspaceDir, raw)
    if (promptPaths.has(target) || promptPaths.has(await canonical(target))) {
      return {
        kind: 'deny' as const,
        reason: '潜意识固定提示词只能由带备份的配置入口修改，不能使用普通文件工具改写',
        info: { name: exec.name, code: 'ELYSIA_ROUTER_PROMPT_READ_ONLY' },
      }
    }
    return next()
  }, { prepend: true })
}

/** Enforce Router-local admission even when the Host shares its Job registry. */
function installJobGuards(ctx: Context, config: Required<Config>): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next) => {
    if (exec.name !== 'bash') return next()
    const args = exec.arguments as BashArgs
    if (args.sandbox_permissions !== undefined) {
      return {
        kind: 'deny' as const,
        reason: '潜意识中枢不支持自主提升沙箱权限',
        info: { name: exec.name, code: 'ELYSIA_SHELL_ESCALATION_DENIED' },
      }
    }
    if (args.run_in_background !== true) return next()
    const active = ctx.jobs.list(ROUTER_SESSION_ID).filter(job => job.owner === ROUTER_SESSION_ID
      && (job.status === 'running' || job.status === 'stopping'))
    if (active.length >= config.maxBackgroundJobs) {
      return {
        kind: 'deny' as const,
        reason: `潜意识中枢最多同时持有 ${config.maxBackgroundJobs} 个后台任务，请先收集或取消已有任务`,
        info: { name: exec.name, code: 'ELYSIA_JOB_LIMIT_REACHED' },
      }
    }
    return next()
  })

  const sweep = (): void => {
    const now = Date.now()
    for (const job of ctx.jobs.list(ROUTER_SESSION_ID)) {
      if (job.owner !== ROUTER_SESSION_ID || (job.status !== 'running' && job.status !== 'stopping')) continue
      if (now - job.startedAt < config.maxJobAgeMs) continue
      try {
        ctx.jobs.kill(job.id, ROUTER_SESSION_ID, `超过潜意识后台任务最大存活时间 ${config.maxJobAgeMs}ms`)
      } catch (error) {
        ctx.logger.warn(`潜意识后台任务超龄回收失败 ${job.id}: ${String(error)}`)
      }
    }
  }
  const timer = setInterval(sweep, config.jobSweepMs)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'elysia-subconscious.job-watchdog()')
}

async function mountShellAndJobs(ctx: Context, config: Required<Config>): Promise<void> {
  // Never reuse the Host's already-probed sandbox/backend: its policy belongs
  // to another workspace, and this host may have probed before our launcher was
  // installed. Isolated service labels allow local providers without replacing
  // or re-registering the Host's services.
  const shellCtx = ctx.isolate('sandboxPolicy').isolate('sandbox').isolate('shell')
  await shellCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspaceDir })
  await shellCtx.plugin(LocalSandboxProvider, {})
  const sandbox = shellCtx.get('sandbox')
  if (sandbox instanceof LocalSandboxProvider) {
    // The vendored DSH source tree omits platform prebuilds. Use the audited
    // official arm64 launcher shipped by this plugin instead of changing DSH.
    sandbox.internals.landlockLauncher = fileURLToPath(new URL('../bin/landlock-run', import.meta.url))
  }
  await shellCtx.plugin(SandboxBashExecutor, {
    cwd: config.workspaceDir,
    timeoutMs: config.shellTimeoutMs,
    maxTimeoutMs: config.shellMaxTimeoutMs,
  })
  if (shellCtx.get('shellEnv') === undefined) await shellCtx.plugin(ShellEnv, {})
  if (shellCtx.get('jobs') === undefined) {
    await shellCtx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: config.maxBackgroundJobs })
  }
  shellCtx.inject(['jobs'], jobsCtx => { installJobGuards(jobsCtx, config) })
  // Completion stays queued for the current or next Router wake; it must not
  // manufacture an unrelated autonomous turn while a Batch is being decided.
  await shellCtx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await shellCtx.plugin(ToolBash, { enableRunInBackground: true, promoteOnTimeout: false })
}

/** Compose only native DSH tools inside the concrete Router Agent scope. */
export async function mountGeneralCapabilities(ctx: Context, config: Required<Config>): Promise<void> {
  for (const [name, value] of [
    ['maxBackgroundJobs', config.maxBackgroundJobs],
    ['maxJobAgeMs', config.maxJobAgeMs],
    ['jobSweepMs', config.jobSweepMs],
    ['shellTimeoutMs', config.shellTimeoutMs],
    ['shellMaxTimeoutMs', config.shellMaxTimeoutMs],
  ] as const) positiveInteger(name, value)
  if (config.shellTimeoutMs > config.shellMaxTimeoutMs) throw new Error('shellTimeoutMs 不能大于 shellMaxTimeoutMs')
  await mkdir(config.workspaceDir, { recursive: true })
  await mkdir(config.skillsDir, { recursive: true })
  await mkdir(config.memoryWorkspaceDir, { recursive: true })
  await guardStandingPromptWrites(ctx, config)
  await ctx.plugin(FileCapabilities, {
    baseDir: config.baseDir,
    files: config.files,
    required: config.required,
    workspaceDir: config.workspaceDir,
    backupDir: config.backupDir,
    readOnlyDirs: [config.skillsDir, config.memoryWorkspaceDir, ...config.readOnlyDirs],
  })
  await ctx.plugin(WebCapabilities)
  await ctx.plugin(SkillCapabilities, { rootDir: config.skillsDir })
  await mountShellAndJobs(ctx, config)
  ctx.inject(['schedule'], scheduleCtx => {
    installScheduleGuard(scheduleCtx)
    void scheduleCtx.plugin(NativeScheduleTools)
  })
}
