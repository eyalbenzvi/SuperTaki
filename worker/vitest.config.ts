import { defineConfig } from 'vitest/config';

// Confined to this directory: without an explicit config Vitest walks up and
// finds the app's config, which pulls in React plugins the worker neither has
// nor wants.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      /*
       * The two files that cannot run here, and are gated elsewhere instead.
       *
       * `room.ts` extends `DurableObject` and `index.ts` builds a `WebSocketPair`; both
       * exist only inside workerd, and a Node stand-in for them would be a test of the
       * stand-in. They are covered by `npm run smoke`, which drives the real worker, the
       * real object and real sockets — and CI runs it in the same job as this. Excluding
       * them keeps the floor below about a number that means something.
       */
      exclude: ['src/room.ts', 'src/index.ts'],
      reporter: ['text', 'lcov'],
      /*
       * A floor under the room, for the reason the app's config gives for its own
       * ratchets — and this is the file that reason was written about.
       *
       * The app gates `clientSession.ts` because the sessions doubled in size during
       * the resilience work while `verify` stayed green over lines that had never once
       * executed. The host half of that pair did not shrink when this change landed: it
       * moved here and grew, into the single largest module in the repository, and it
       * now owns every hand, every rule and every deadline. Leaving it ungated would
       * have reproduced exactly the condition the app's comment describes, on a bigger
       * file — and it did, until an audit found two alarm loops in lines the tests
       * execute but never assert about.
       *
       * Set just under where it stands, so it ratchets rather than blocks.
       */
      thresholds: {
        'src/**/*.ts': {
          statements: 85,
          branches: 76,
          functions: 90,
          lines: 85,
        },
      },
    },
  },
});
