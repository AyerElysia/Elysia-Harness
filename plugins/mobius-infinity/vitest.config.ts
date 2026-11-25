import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../dsh/vitest.shared.ts'

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url))

// This package is an out-of-tree consumer of the vendored harness: workspace
// imports resolve through node_modules to the vendored build (`lib/`), exactly
// the artifact plane the shipped profiles load. Mapping them to `src/` instead
// would compile the whole harness outside its own project references, and the
// `const enum` FiberState would arrive as `undefined` under esbuild's per-file
// transform. The decorator plugin is still required: `@Remote` is a standard
// decorator that Vite's default parser does not accept.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin()],
  server: { fs: { allow: [harnessRoot] } },
  test: {
    include: ['tests/**/*.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
