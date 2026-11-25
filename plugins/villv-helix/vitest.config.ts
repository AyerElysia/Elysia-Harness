import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../dsh/vitest.shared.ts'

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url))

// This package is an out-of-tree consumer of the vendored harness: workspace
// imports resolve through node_modules to the vendored build (`lib/`), exactly
// the artifact plane the shipped profiles load. The decorator plugin is
// required because `@Remote` is a standard decorator that Vite's default
// parser does not accept.
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