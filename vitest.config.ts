import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // The store tests do real file I/O in temp folders; on a busy machine
    // (for example while DSH reloads this linked plugin) a run can stall for
    // a few seconds. A genuinely hung test still fails.
    testTimeout: 20_000,
  },
})
