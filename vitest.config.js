import { defineConfig } from "vitest/config";
var vitest_config_default = defineConfig({
  resolve: {
    alias: {
      "@jackwener/opencli/registry": "/usr/lib/node_modules/@jackwener/opencli/dist/registry-api.js"
    }
  },
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
export {
  vitest_config_default as default
};
