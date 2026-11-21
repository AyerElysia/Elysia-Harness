import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { ConfigError, resolveDeploymentPaths } from '../src/config.ts'
import { apply } from '../src/index.ts'

function failure(work: () => unknown): ConfigError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return error as ConfigError
  }
  throw new Error('应当抛 ConfigError')
}

it('requires every deployment path to come from the profile', () => {
  const base = { baseDir: '/prompts', files: [] }
  expect(failure(() => resolveDeploymentPaths({ ...base }))).toMatchObject({ code: 'CONFIG_PATH_REQUIRED' })
  expect(failure(() => resolveDeploymentPaths({ ...base })).message).toContain('stateDir')
  expect(failure(() => resolveDeploymentPaths({ ...base, stateDir: '/state' })).message).toContain('workspaceDir')
  expect(failure(() => resolveDeploymentPaths({ ...base, stateDir: '/state', workspaceDir: '/workspace/router' }))
    .message).toContain('skillsDir')
  expect(failure(() => resolveDeploymentPaths({
    ...base, stateDir: '/state', workspaceDir: '/workspace/router', skillsDir: '/skills', memoryWorkspaceDir: '   ',
  })).message).toContain('memoryWorkspaceDir')
})

it('derives the memory workspace beside the configured Router workspace', () => {
  const workspaceDir = join('/srv/elysia', 'workspace', 'subconscious', 'router')
  expect(resolveDeploymentPaths({ baseDir: '/prompts', files: [], stateDir: '/srv/state', workspaceDir, skillsDir: '/srv/skills' }))
    .toEqual({ stateDir: '/srv/state', workspaceDir, skillsDir: '/srv/skills', memoryWorkspaceDir: join(dirname(workspaceDir), 'memory') })
  expect(resolveDeploymentPaths({
    baseDir: '/prompts', files: [], stateDir: '/srv/state', workspaceDir, skillsDir: '/srv/skills',
    memoryWorkspaceDir: '/srv/memory-workspace',
  }).memoryWorkspaceDir).toBe('/srv/memory-workspace')
})

it('fails the plugin mount loudly when the profile omits a deployment path', () => {
  expect(() => apply(new Context(), { baseDir: '/prompts', files: [] })).toThrow(/stateDir/u)
})
