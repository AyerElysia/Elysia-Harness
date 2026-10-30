import { defineConfig } from 'vitest/config'

// The elysia channel/mind plugins live outside dsh/packages, so the stock
// vitest configs never pick their tests up. Run from dsh/:
//   node_modules/.bin/vitest run --config vitest.elysia.config.ts
export default defineConfig({
  test: {
    include: ['../plugins/*/tests/**/*.spec.ts'],
  },
})
