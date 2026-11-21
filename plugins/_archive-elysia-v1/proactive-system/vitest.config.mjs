import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standardDecoratorPlugin } from '../../dsh/vitest.shared.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dshRoot = resolve(root, 'dsh')
const requireDsh = createRequire(new URL('../../dsh/package.json', import.meta.url))
const ts = requireDsh('typescript')
const parsed = ts.readConfigFile(resolve(dshRoot, 'tsconfig.base.json'), ts.sys.readFile)
if (parsed.error) throw new Error('Cannot read vendored DSH source aliases')
const alias = Object.entries(parsed.config.compilerOptions.paths).flatMap(([name, choices]) =>
  name.includes('*') || choices[0] === undefined ? [] : [{
    find: new RegExp('^' + name.replaceAll('.', '\\\\.') + '$'),
    replacement: resolve(dshRoot, choices[0]),
  }])
alias.push({
  find: '@deepseek-ai/dsh-api-session-controller/src/agent.ts',
  replacement: resolve(dshRoot, 'packages/api/session-controller/src/agent.ts'),
})

export default {
  root,
  plugins: [standardDecoratorPlugin()],
  resolve: { alias },
  server: { fs: { allow: [root] } },
  test: {
    include: ['plugins/proactive-system/tests/**/*.spec.ts', 'plugins/conscious-mind/tests/plans-integration.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 10000,
  },
}
