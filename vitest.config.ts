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
        /*
         * The robot's brain is pure logic with no excuse for gaps, and it is held to
         * the engine's own bar. Its driver owns timers and is held slightly lower:
         * the parts a test cannot reach are the platform's, not the decision's.
         */
        'src/features/game/bot/policy.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/features/game/bot/view.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/features/game/bot/runner.ts': {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90,
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
        /*
         * The store is gated for the same reason the sessions are.
         *
         * It grew by a third during this work — resuming a host, accepting a handover,
         * the table controls, the wake hook — and the pipeline could not tell, because
         * everything it gained was reachable only through a session and none of it was
         * ever driven. Two of the defects found afterwards lived in exactly those
         * lines.
         */
        'src/features/game/state/store.ts': {
          statements: 78,
          branches: 60,
          functions: 80,
          lines: 78,
        },
        'src/features/game/state/hostSnapshot.ts': {
          statements: 85,
          branches: 78,
          functions: 95,
          lines: 85,
        },
        /*
         * The small libraries the resilience work introduced. They are short enough
         * that a gap is always a whole behaviour rather than an edge: the wake lock
         * sat at 41% while holding a double-request bug, which is precisely the shape
         * of thing a floor here catches.
         */
        'src/lib/{lifecycle,wakeLock,diagnostics}.ts': {
          statements: 90,
          branches: 82,
          functions: 88,
          lines: 90,
        },
      },
    },
  },
});
