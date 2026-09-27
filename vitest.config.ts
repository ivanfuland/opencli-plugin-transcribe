import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jackwener/opencli/registry': '/usr/lib/node_modules/@jackwener/opencli/dist/src/registry-api.js',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 跑测试的人自己那份 ~/.config/opencli/transcribe.json 不该影响结果
    env: { TRANSCRIBE_CONFIG_FILE: '/nonexistent/cc-transcribe-config.json' },
  },
});
