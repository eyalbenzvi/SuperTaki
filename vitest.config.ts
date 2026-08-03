import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/component/**/*.test.tsx'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/**/index.ts',
        'src/vite-env.d.ts',
        // Thin wrapper over BroadcastChannel; exercised by the e2e suite, which
        // uses it as its transport.
        'src/features/game/network/broadcastTransport.ts',
      ],
      thresholds: {
        'src/features/game/engine/**/*.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/features/game/network/protocol.ts': {
          statements: 90,
          branches: 85,
          functions: 85,
          lines: 90,
        },
      },
    },
  },
});
