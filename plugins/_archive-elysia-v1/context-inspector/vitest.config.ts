import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
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

// This plugin sits outside dsh/, so the tsconfig-paths plugin cannot discover
// its sibling resolver from the importer ancestry. Reuse the exact official
// source aliases explicitly: built browser artifacts are window closure factories.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: exactAliases },
  server: { fs: { allow: [harnessRoot] } },
  test: {
    include: ['tests/**/*.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
