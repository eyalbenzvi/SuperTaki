import { defineConfig } from 'vitest/config';

// Confined to this directory: without an explicit config Vitest walks up and
// finds the app's config, which pulls in React plugins the worker neither has
// nor wants.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
