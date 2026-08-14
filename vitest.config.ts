import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@opsense/ai-codex': fileURLToPath(
        new URL('./packages/ai-codex/src/index.ts', import.meta.url),
      ),
      '@opsense/agent-runtime': fileURLToPath(
        new URL('./packages/agent-runtime/src/index.ts', import.meta.url),
      ),
      '@opsense/ai-provider': fileURLToPath(
        new URL('./packages/ai-provider/src/index.ts', import.meta.url),
      ),
      '@opsense/collectors': fileURLToPath(
        new URL('./packages/collectors/src/index.ts', import.meta.url),
      ),
      '@opsense/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@opsense/discovery': fileURLToPath(
        new URL('./packages/discovery/src/index.ts', import.meta.url),
      ),
      '@opsense/redaction': fileURLToPath(
        new URL('./packages/redaction/src/index.ts', import.meta.url),
      ),
      '@opsense/report': fileURLToPath(new URL('./packages/report/src/index.ts', import.meta.url)),
      '@opsense/projection': fileURLToPath(
        new URL('./packages/projection/src/index.ts', import.meta.url),
      ),
      '@opsense/schema': fileURLToPath(new URL('./packages/schema/src/index.ts', import.meta.url)),
      '@opsense/ssh': fileURLToPath(new URL('./packages/ssh/src/index.ts', import.meta.url)),
      '@opsense/workspace': fileURLToPath(
        new URL('./packages/workspace/src/index.ts', import.meta.url),
      ),
      '@opsense/wiki': fileURLToPath(new URL('./packages/wiki/src/index.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    include: ['tests/**/*.test.ts', 'apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
