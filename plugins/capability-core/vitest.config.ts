import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../dsh/vitest.shared.ts'

const harnessRoot = fileURLToPath(new URL('../../', import.meta.url))

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