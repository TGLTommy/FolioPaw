import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test module so an accidental `npx vitest` cannot open
    // the real database or delete the real upload directory.
    setupFiles: ['./src/test/guard-test-environment.ts'],
    // These are integration tests over process-global state: one upload
    // directory, singleton services, and background translation jobs. Running
    // files in parallel lets one suite delete the upload directory while
    // another is mid-upload, which surfaced as sporadic HTTP 500s on CI. The
    // whole suite takes a couple of seconds, so serialising files is cheap.
    fileParallelism: false,
  },
});
