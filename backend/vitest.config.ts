import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test module so an accidental `npx vitest` cannot open
    // the real database or delete the real upload directory.
    setupFiles: ['./src/test/guard-test-environment.ts'],
  },
});
