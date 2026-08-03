import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` must match the GitHub Pages path the site is served from.
 *
 * - Project pages (`https://<user>.github.io/<repo>/`) need `base = '/<repo>/'`.
 *   The deploy workflow sets `VITE_BASE_PATH` from the repository name automatically.
 * - User/organisation pages or a custom domain need `base = '/'`.
 *
 * See docs/deployment.md for details.
 */
const base = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
