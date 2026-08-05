import { defineConfig, type Plugin } from 'vite';
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

/**
 * The CSP names the relay explicitly, and the relay is configured per build —
 * so the `connect-src` entry has to be derived, not hard-coded. `%RELAY_CSP%`
 * in `index.html` becomes the configured relay origin, or the local
 * `wrangler dev` origins when no relay is set (development and previews).
 */
function relayCspSource(): string {
  const url = process.env.VITE_RELAY_URL;
  if (url && url.length > 0) {
    return url.replace(/\/+$/, '');
  }
  return 'ws://127.0.0.1:8787 http://127.0.0.1:8787';
}

function injectRelayCsp(): Plugin {
  return {
    name: 'super-taki:relay-csp',
    transformIndexHtml(html) {
      return html.replace('%RELAY_CSP%', relayCspSource());
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), injectRelayCsp()],
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
