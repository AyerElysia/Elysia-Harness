import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standardDecoratorPlugin } from '../../dsh/vitest.shared.ts'

const dshRoot = fileURLToPath(new URL('../../dsh/', import.meta.url))
const harnessRoot = fileURLToPath(new URL('../../', import.meta.url))
const requireDsh = createRequire(new URL('../../dsh/package.json', import.meta.url))
const ts = requireDsh('typescript') as typeof import('typescript')
const parsed = ts.readConfigFile(resolve(dshRoot, 'tsconfig.base.json'), ts.sys.readFile)
if (parsed.error !== undefined) throw new Error('Cannot read vendored DSH source aliases')
const paths = parsed.config.compilerOptions.paths as Record<string, readonly string[]>
const exactAliases = Object.entries(paths).flatMap(([name, choices]) => name.includes('*') || choices[0] === undefined
  ? []
  : [{ find: new RegExp('^' + name.replaceAll('.', '\\.') + '$'), replacement: resolve(dshRoot, choices[0]) }])

// Resolve this external plugin against native DSH source faces without
// installing dependencies or collecting unrelated workspace suites.
export default {
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: exactAliases },
  server: { fs: { allow: [harnessRoot] } },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
}
