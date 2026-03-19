import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    restoreMocks: true,
    env: {
      UPSTREAM: 'http://localhost:6001',
    },
  },
});
