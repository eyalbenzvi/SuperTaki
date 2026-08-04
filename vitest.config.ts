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
        /*
         * A floor for the session layer, set just under where it stands.
         *
         * It exists because of a specific failure: the sessions roughly doubled in
         * size during the resilience work and `verify` stayed green while the added
         * lines — the absence machinery, the heartbeat's judgement, the lobby grace —
         * had never once executed. Only the engine and the protocol were gated, so
         * nothing in the pipeline could notice. A ratchet here makes the next such
         * gap visible at the moment it is introduced rather than in an audit.
         */
        'src/features/game/network/{client,host}Session.ts': {
          statements: 75,
          branches: 65,
          functions: 78,
          lines: 75,
        },
        'src/features/game/network/watchdog.ts': {
          statements: 85,
          branches: 74,
          functions: 90,
          lines: 85,
        },
      },
    },
  },
});
