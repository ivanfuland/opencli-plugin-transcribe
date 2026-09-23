import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jackwener/opencli/registry': '/usr/lib/node_modules/@jackwener/opencli/dist/src/registry-api.js',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
