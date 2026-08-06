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
       * stand-in. Excluding them keeps this floor about a number that means something.
       *
       * What covers them is `npm run smoke`, which drives the real worker, the real object
       * and real sockets, and which CI runs in the same job as this. Honestly, though: smoke
       * drives the happy path — create, collide, join, deal, dedup, resume, win — so the
       * adapter's own newest lines (`reapUnjoined`, the attachment lifecycle, the
       * `deleteAll()` on a forgotten room) are exercised by nothing. That is a gap, not a
       * claim; it is stated here rather than papered over by a threshold that excludes it.
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
      /*
       * Per file, not per glob. A glob key aggregates every file it matches into one
       * coverage map, so `alarms.ts` at 98 % and `storage.ts` at 100 % cushioned the one
       * file the paragraph above is actually about — `gameRoom.ts` could have fallen
       * several points and still passed — and a brand-new, entirely untested module
       * would have passed too, which is precisely the condition this gate exists to
       * catch. `perFile` makes each file answer for itself.
       */
      thresholds: {
        perFile: true,
        'src/**/*.ts': {
          statements: 85,
          branches: 75,
          functions: 88,
          lines: 85,
        },
      },
    },
  },
});
