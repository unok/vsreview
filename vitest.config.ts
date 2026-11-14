import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], alias: { vscode: resolve(__dirname, 'test/vscodeMock.ts') } },
});
