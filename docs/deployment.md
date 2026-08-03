# Deploying to GitHub Pages

The whole app is static files. Deployment is: build, upload the `dist/` folder as a Pages
artifact, publish. The repository already contains a workflow that does all of it.

## One-time setup

1. **Push the repository to GitHub** (any visibility; Pages works on public repositories on
   every plan, and on private repositories on paid plans).

2. **Enable Pages from Actions.**
   Repository → **Settings** → **Pages** → **Build and deployment** → **Source**:
   choose **GitHub Actions**.

   This is the only manual step. Do _not_ pick "Deploy from a branch" — that would serve the
   raw source instead of the build.

3. **Check Actions permissions** (usually already correct).
   Settings → **Actions** → **General** → **Workflow permissions**: "Read repository contents
   and packages permissions" is enough. The deploy workflow requests the extra scopes it needs
   itself:

   ```yaml
   permissions:
     contents: read
     pages: write
     id-token: write
   ```

   `pages: write` uploads the artifact and creates the deployment; `id-token: write` lets
   `actions/deploy-pages` prove the deployment came from this workflow run (OIDC). Granting
   them in the workflow rather than repository-wide keeps every other workflow read-only.

4. **Push to `main`.** The `Deploy to GitHub Pages` workflow runs, and the finished URL appears
   in the run summary and under Settings → Pages. It is
   `https://<user>.github.io/<repo>/` for a project page.

That is the whole setup. There is nothing to configure per environment, no secret to add and no
service to sign up for.

## What the workflow does

`.github/workflows/deploy-pages.yml`, triggered by pushes to `main` and by manual dispatch
(Actions → Deploy to GitHub Pages → Run workflow):

1. `actions/checkout@v4`
2. `actions/setup-node@v4` with Node 22 and npm cache
3. `npm ci` — an exact, lockfile-driven install
4. `actions/configure-pages@v5` — reports the site's origin and base path
5. **Resolve the base path** — normalises that value into a Vite `base` with a trailing slash
6. `npm run build` with `VITE_BASE_PATH` set (this also runs `tsc -b`, so a type error fails
   the deploy)
7. Copy `dist/index.html` to `dist/404.html` and create `dist/.nojekyll`
8. `actions/upload-pages-artifact@v3` with `path: dist`
9. `actions/deploy-pages@v4` in the `github-pages` environment

Concurrency is `group: pages` with `cancel-in-progress: false`, so overlapping pushes queue
instead of one silently cancelling another.

## Base path, in detail

A Vite build hard-codes the prefix for its asset URLs at build time. Get it wrong and the page
loads but the JavaScript and CSS 404 — the classic "blank page after deploying".

| Where the site is served                                                           | Correct `base` |
| ---------------------------------------------------------------------------------- | -------------- |
| `https://user.github.io/color-rush/` (project page)                                | `/color-rush/` |
| `https://user.github.io/` (user or organisation page, repo named `user.github.io`) | `/`            |
| `https://cards.example.com/` (custom domain)                                       | `/`            |

`vite.config.ts` reads it from the environment:

```ts
const base = process.env.VITE_BASE_PATH ?? '/';
```

The workflow derives it from `actions/configure-pages`, which knows the real serving path, so
**all three cases work with no edit.** The normalisation step only adds a trailing slash and
maps an empty value to `/`.

Building locally for a project page:

```bash
VITE_BASE_PATH=/color-rush/ npm run build
VITE_BASE_PATH=/color-rush/ npm run preview   # serves at http://localhost:4173/color-rush/
```

Pass the variable to `preview` as well: `vite.config.ts` reads it when the config loads, so
without it the preview server would serve the sub-path build from `/` and every asset would
404 — which is exactly the failure this check is meant to catch.

If you rename the repository, nothing needs changing — the next deploy picks up the new path.

## Routing and 404.html

GitHub Pages cannot rewrite unknown paths to `index.html`, so this app uses **hash routing**:
invite links look like

```
https://user.github.io/color-rush/#/join?room=TIGER-MANGO-42
```

Everything after `#` never reaches the server, so Pages always serves `index.html` and the app
reads the fragment itself. That is why no rewrite configuration is needed.

`404.html` is a copy of `index.html` purely as a safety net for a mistyped path — a visitor
lands on the app instead of GitHub's error page. `.nojekyll` stops Pages from running Jekyll,
which would otherwise ignore files and folders beginning with an underscore.

## Custom domain

1. Settings → Pages → **Custom domain**: enter the domain and save. GitHub stores a `CNAME`
   file in the Pages deployment for you.
2. At your DNS provider, point the domain at GitHub Pages:
   - apex domain: `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153` (and/or the `AAAA` equivalents);
   - subdomain: a `CNAME` to `<user>.github.io`.
3. Wait for the certificate, then tick **Enforce HTTPS**.
4. No build change is needed: `configure-pages` reports `/` as the base path for a custom
   domain, and the workflow follows.

HTTPS matters beyond good practice: `getRandomValues`, the Clipboard API and WebRTC all require
a secure context. `github.io` and a custom domain with HTTPS enforced both qualify.

## Optional: your own PeerServer or TURN server

Not needed, and not free if you self-host — but supported. Add these as repository
**Variables** (Settings → Secrets and variables → Actions → **Variables**, not Secrets — they
are baked into a public bundle and are not secret):

| Variable           | Effect                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `VITE_PEER_HOST`   | Your PeerServer hostname. Setting this switches signalling away from the public broker.                              |
| `VITE_PEER_PORT`   | Port; defaults to 443 when secure, 9000 otherwise.                                                                   |
| `VITE_PEER_PATH`   | Path; defaults to `/`.                                                                                               |
| `VITE_PEER_SECURE` | `false` for plain HTTP/WS.                                                                                           |
| `VITE_PEER_KEY`    | PeerServer key, if you configured one.                                                                               |
| `VITE_ICE_SERVERS` | JSON array of `RTCIceServer` objects, e.g. `[{"urls":"turn:turn.example.org:3478","username":"u","credential":"c"}]` |

Then **update the Content Security Policy** in `index.html` so `connect-src` includes your host
— otherwise the browser will block the connection:

```
connect-src 'self' https://peer.example.org wss://peer.example.org stun: turn: turns:;
```

A TURN server is the one thing that would make connections work on restrictive networks. It
costs money to run, which is why the default configuration does not include one.

## Verifying a deployment

1. Open the Pages URL. The Hebrew landing screen should appear, right-to-left.
2. Open developer tools → Network and reload: no 404s for `/assets/...`.
3. Create a room; a room code and invite link appear.
4. Open the invite link on a second device and join. Both should show "2 of N players".
5. Start the game. Each player sees eight cards, and only their own.

For a quick single-device check without WebRTC, append `?transport=broadcast` to the URL in two
tabs.

## Troubleshooting

| Symptom                                  | Cause and fix                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Blank page, 404s for `/assets/*.js`      | Wrong `base`. Confirm the workflow ran (not a branch deploy) and check the resolved base in the "Resolve base path" step log. |
| "Get Pages site failed" in the workflow  | Pages source is not set to **GitHub Actions**. Fix it in Settings → Pages.                                                    |
| "Resource not accessible by integration" | The workflow's `permissions` block was edited. It needs `pages: write` and `id-token: write`.                                 |
| Deployment succeeds, old content served  | Pages CDN caching. Hard-reload; give it a minute.                                                                             |
| Site works, rooms never connect          | Signalling or NAT, not deployment. Try `?debug=1` and read the console; see the README's limitations section.                 |
| Invite links 404                         | Only happens if routing was changed away from hash-based. Keep the `#/join?...` form.                                         |
| Assets load over HTTP and features fail  | Enable **Enforce HTTPS**. WebRTC and the Clipboard API need a secure context.                                                 |

## Deploying somewhere else

Any static host works — Netlify, Cloudflare Pages, S3, a plain nginx directory. Build with the
right base for the path you serve from (usually `/`, i.e. no `VITE_BASE_PATH`), upload `dist/`,
and serve `index.html` for unknown paths if the host supports it. Nothing in the app depends on
GitHub specifically.
