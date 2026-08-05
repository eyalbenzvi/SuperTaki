# Deploying to GitHub Pages

The whole app is static files. Deployment is: build, upload the `dist/` folder as a Pages
artifact, publish. The repository already contains a workflow that does all of it.

## One-time setup

1. **Push the repository to GitHub** (any visibility; Pages works on public repositories on
   every plan, and on private repositories on paid plans).

2. **Enable Pages.**
   Repository → **Settings** → **Pages** → **Build and deployment** → **Source**:
   choose **GitHub Actions**.

   This is the only manual step, and it genuinely cannot be automated. Setting
   `enablement: true` on `actions/configure-pages` was tried and refused with
   `Resource not accessible by integration` — the default `GITHUB_TOKEN` may deploy to an
   existing Pages site but not create one. Do _not_ pick "Deploy from a branch" either; that
   would serve the raw source instead of the build.

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

4. **Push to the default branch.** The `Deploy to GitHub Pages` workflow runs, and the finished
   URL appears in the run summary and under Settings → Pages. It is
   `https://<user>.github.io/<repo>/` for a project page.

   The workflow keys off `github.event.repository.default_branch` rather than a hard-coded
   `main`, because GitHub's `github-pages` environment only permits deployments from the default
   branch — anything else is refused with
   `Branch … is not allowed to deploy to github-pages due to environment protection rules`.
   Keying off the default branch matches that rule exactly and survives a rename. Pushes to other
   branches trigger the workflow but skip both jobs, which is intentional.

That is the whole setup. There is nothing to configure per environment, no secret to add and no
service to sign up for.

> Until step 2 is done, the workflow fails at the "Configure Pages" step with
> `Get Pages site failed … verify that the repository has Pages enabled`. That message is the
> reminder; nothing else is wrong. Re-run the workflow (or push again) once Pages is on.

## What the workflow does

`.github/workflows/deploy-pages.yml`, triggered by pushes to the default branch and by manual
dispatch (Actions → Deploy to GitHub Pages → Run workflow):

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
| `https://user.github.io/super-taki/` (project page)                                | `/super-taki/` |
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
VITE_BASE_PATH=/super-taki/ npm run build
VITE_BASE_PATH=/super-taki/ npm run preview   # serves at http://localhost:4173/super-taki/
```

Pass the variable to `preview` as well: `vite.config.ts` reads it when the config loads, so
without it the preview server would serve the sub-path build from `/` and every asset would
404 — which is exactly the failure this check is meant to catch.

If you rename the repository, nothing needs changing — the next deploy picks up the new path.

## Routing and 404.html

GitHub Pages cannot rewrite unknown paths to `index.html`, so this app uses **hash routing**:
invite links look like

```
https://user.github.io/super-taki/#/join?room=482913
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

HTTPS matters beyond good practice: `getRandomValues`, the Clipboard API and secure
WebSockets all require or expect a secure context. `github.io` and a custom domain with
HTTPS enforced both qualify.

## The relay: one-time Cloudflare setup

The game's multiplayer runs through the relay in `worker/` — a Cloudflare Worker with one
Durable Object per room, on the free plan (no credit card). Deploying it once:

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Copy the **Account ID** from the dashboard's overview page.
3. Create an API token: My Profile → API Tokens → Create Token → the **Edit Cloudflare
   Workers** template.
4. Add repository **Secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. Push to the default branch, or run the **Deploy relay worker** workflow manually. It
   typechecks, tests, deploys, and prints the worker URL in the run summary.
6. Add a repository **Variable** (Variables, not Secrets — it is baked into a public
   bundle): `RELAY_URL`, set to the worker URL with a `wss://` scheme, e.g.
   `wss://supertaki-relay.<your-subdomain>.workers.dev`.
7. Re-run the Pages deploy (push anything, or dispatch it manually). The build injects the
   URL into the app and into the Content Security Policy — no manual CSP edit is needed.

Without `RELAY_URL`, a production build only knows how to reach a local `wrangler dev` on
`127.0.0.1:8787`, which is the right default for development and the wrong one for a
deployed site.

The relay redeploys automatically whenever `worker/**` changes on the default branch. To
restrict which sites may use your relay, set an `ALLOWED_ORIGINS` variable on the worker in
the Cloudflare dashboard (comma-separated origins); unset, any origin may connect, which is
acceptable for a relay that carries no secrets and stores no game state.

## Verifying a deployment

1. Open the Pages URL. The Hebrew landing screen should appear, right-to-left.
2. Open developer tools → Network and reload: no 404s for `/assets/...`.
3. Create a room; a room code and invite link appear.
4. Open the invite link on a second device and join. Both should show "2 of N players".
5. Start the game. Each player sees eight cards, and only their own.

For a quick single-device check that skips the relay, append `?transport=broadcast` to the URL
in two tabs.

## Troubleshooting

| Symptom                                             | Cause and fix                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Blank page, 404s for `/assets/*.js`                 | Wrong `base`. Confirm the workflow ran (not a branch deploy) and check the resolved base in the "Resolve base path" step log.       |
| "Get Pages site failed" in the workflow             | Pages source is not set to **GitHub Actions**. Fix it in Settings → Pages.                                                          |
| "Resource not accessible by integration"            | The workflow's `permissions` block was edited. It needs `pages: write` and `id-token: write`.                                       |
| Deployment succeeds, old content served             | Pages CDN caching. Hard-reload; give it a minute.                                                                                   |
| "Branch … is not allowed to deploy to github-pages" | You pushed to a branch that is not the repository default. Push to the default branch, or change the default in Settings → General. |
| Workflow ran but both jobs were skipped             | Same cause: the push was not to the default branch. The skip is intentional.                                                        |
| Site works, rooms never connect                     | Signalling or NAT, not deployment. Try `?debug=1` and read the console; see the README's limitations section.                       |
| Invite links 404                                    | Only happens if routing was changed away from hash-based. Keep the `#/join?...` form.                                               |
| Assets load over HTTP and features fail             | Enable **Enforce HTTPS**. Secure WebSockets and the Clipboard API need a secure context.                                                       |

## Deploying somewhere else

Any static host works — Netlify, Cloudflare Pages, S3, a plain nginx directory. Build with the
right base for the path you serve from (usually `/`, i.e. no `VITE_BASE_PATH`), upload `dist/`,
and serve `index.html` for unknown paths if the host supports it. Nothing in the app depends on
GitHub specifically.
