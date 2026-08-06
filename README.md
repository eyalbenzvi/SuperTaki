# Super Taki

**A private game of Taki — in the browser, at exactly zero cost.**

Super Taki is a mobile-first multiplayer card game for 2–6 players. One person opens a
room and shares it however suits the room they are in — a link, a six-digit code, or the QR
code on their screen — and everyone else joins from their own phone, tablet or laptop.
There is no account, no database and no paid service anywhere in the stack: the site is
static files on GitHub Pages, and the game itself runs in one Durable Object per room on
Cloudflare's free plan — which deals the cards, keeps the rules and holds the table
together while people's phones come and go.

A table can also seat **robot players**, which is what makes one player a game and what keeps a
round moving when somebody's phone dies: after a long absence — or a long silence — a robot can
play that seat until its owner comes back, and hands it over the moment they do. Robots run in
the room and see exactly what a player sees, never anybody's hand. See
[docs/robots.md](docs/robots.md).

The interface is Hebrew by default (right-to-left), with English one tap away in Settings. The deck is the
full Super Taki deck — numbers 1 and 3–9, Stop, Plus, +2, Change Direction and Taki in four
colours, plus Change Colour, Super Taki, King, +3 and the +3 Breaker. There is no plain 2:
the only 2 in Taki is the +2. "Last card" is declared with a button, and a player who stays
silent on a single card can be caught by anybody else for four cards — a beat after
their card lands, so the declaration is a decision rather than a race. The exact rules the engine
implements are in [docs/rules.md](docs/rules.md); the app has no rules page, so read that
if a card's behaviour is not what you expected.

---

## Table of contents

- [Zero-cost architecture](#zero-cost-architecture)
- [Quick start](#quick-start)
- [npm scripts](#npm-scripts)
- [Local development](#local-development)
- [Running the tests](#running-the-tests)
- [Building](#building)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [Configuring the base path](#configuring-the-base-path)
- [The room server](#the-room-server-read-this)
- [Privacy](#privacy)
- [Browser compatibility](#browser-compatibility)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Disclaimer](#disclaimer)
- [Licence](#licence)

---

## Zero-cost architecture

| Concern               | How it is solved                                                        | Cost                        |
| --------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Hosting               | Static build on GitHub Pages                                            | Free                        |
| Multiplayer transport | One WebSocket per player to the room (`worker/`)                        | Free (Cloudflare free plan) |
| The game itself       | One Durable Object per room code, hibernating between moves             | Free                        |
| Game state            | The room's own SQLite storage, deleted 6 h after the last player leaves | Free                        |
| Timers                | The object's single alarm, multiplexed — no polling                     | Free                        |
| Accounts / identity   | None; a random local id and a display name                              | Free                        |
| Persistence on device | `localStorage` for preferences and a rejoin token                       | Free                        |
| Analytics / telemetry | None at all                                                             | Free                        |

The server is yours: a few hundred lines of TypeScript in `worker/`, deployed to a free
Cloudflare account with no credit card. A full game evening uses well under one percent of the
free plan's daily allowance — a room wakes only when somebody moves or a deadline comes due,
and an empty one costs nothing at all until it deletes itself.

**Nobody's tab is the game.** Every player, including whoever opened the room, sends _intents_
("play this card") and renders what the room confirms. Anyone can close their tab, lose their
phone or vanish for an hour; the table is where they left it, and one tap puts them back in
their seat. See [docs/architecture.md](docs/architecture.md).

## Quick start

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
npm run dev
```

You also need the room running. In a second terminal:

```bash
cd worker && npm install && npm run dev
```

`npm run dev` in the app points at `ws://127.0.0.1:8787` by default, so the two find each
other with no configuration. Open the printed URL, create a room in one tab, copy the room
code, and join from another — two tabs of the same browser are two ordinary players, because
there is no longer a same-device special case.

Requirements: Node.js 20+ (CI uses 22) and npm 10+.

## npm scripts

| Script                            | What it does                                       |
| --------------------------------- | -------------------------------------------------- |
| `npm run dev`                     | Vite dev server with hot reload                    |
| `npm run build`                   | Typecheck (`tsc -b`) then produce `dist/`          |
| `npm run build:e2e`               | The same, pointed at a local `wrangler dev` room   |
| `npm run preview`                 | Serve the built `dist/` locally on port 4173       |
| `npm run typecheck`               | TypeScript project references, no emit             |
| `npm run lint`                    | ESLint (type-aware) over the whole repository      |
| `npm run lint:fix`                | ESLint with `--fix`                                |
| `npm run format` / `format:check` | Prettier write / verify                            |
| `npm test`                        | Vitest unit + component tests once                 |
| `npm run test:watch`              | Vitest in watch mode                               |
| `npm run test:coverage`           | Vitest with V8 coverage and thresholds             |
| `npm run test:e2e`                | Playwright end-to-end tests against the built site |
| `npm run test:e2e:ui`             | Playwright interactive UI mode                     |
| `npm run verify`                  | format:check → lint → typecheck → coverage → build |

## Local development

- `npm run dev` serves the app with hot reload. Debug logging is on automatically in dev.
- In a production build, append `?debug=1` to enable the same logging for the tab
  (`?debug=0` turns it off again). Nothing is logged in production otherwise.
- Two windows on one device are just two players joining the same room. There used to be a
  `?transport=broadcast` switch for this, back when a same-device game had no server to
  connect to; it is gone with the transport it selected.

## Running the tests

```bash
npm test                # 798 unit + component tests
npm run test:coverage   # same, with coverage thresholds enforced
npm run test:e2e        # 50 scenarios x 2 viewports (needs a Chromium download once)
```

Playwright downloads Chromium on first use (`npx playwright install chromium`). If your
environment already has a Chromium build, point Playwright at it instead:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e
```

The end-to-end suite drives two real pages through the production bundle against the **real
room** under `wrangler dev` — Playwright starts both servers. That is the production path,
minus the domain name. It used to run over a `BroadcastChannel` stand-in, because there was
no server to run; there is one now, and it runs locally, so there is no reason to test a
lookalike.

Use `npm run build:e2e` if you are building by hand: the worker's URL is baked into the
bundle _and_ into the page's `connect-src`, so a preview built without it has no room to
talk to.

`npm run smoke` inside `worker/` is the layer below: it starts the same worker and plays a
whole round over raw WebSockets — create, a room-code collision, a join, a lobby command
refused from the wrong seat, a deal, a privacy sweep, a replayed request, a drop and resume,
and a winner.

## Building

```bash
npm run build     # -> dist/
npm run preview   # serve dist/ at http://localhost:4173
```

The build is entirely static: HTML, CSS, JS and a source map. No server-side rendering, no
runtime environment variables.

## Deploying to GitHub Pages

1. **Enable Pages once, by hand.** Repository → **Settings** → **Pages** → **Build and
   deployment** → **Source** → **GitHub Actions**. This step cannot be automated: the workflow's
   `GITHUB_TOKEN` is allowed to _deploy_ to Pages but not to _create_ the Pages site.
2. **Push to the default branch.** The `Deploy to GitHub Pages` workflow builds and publishes on
   every push to whichever branch is the repository default, and on manual dispatch.

The workflow keys off the **default branch** rather than a hard-coded `main`, because GitHub's
`github-pages` environment refuses deployments from any other branch. Whatever your default
branch is called, pushing to it publishes, and renaming it needs no change here. Pushes to other
branches appear as skipped runs.

The finished URL appears in the run summary and under Settings → Pages —
`https://<user>.github.io/<repo>/` for a project page. Until step 1 is done the workflow fails
with `Get Pages site failed`, which is the reminder to do it. Full details, including custom
domains and troubleshooting, are in [docs/deployment.md](docs/deployment.md).

## Configuring the base path

A project page is served from `https://<user>.github.io/<repo>/`, so Vite needs
`base = '/<repo>/'`. The deploy workflow derives this automatically from
`actions/configure-pages`, so **project pages, user/organisation pages and custom domains
all work without editing anything.**

To build locally for a project page:

```bash
VITE_BASE_PATH=/super-taki/ npm run build
```

Routing uses the URL hash (`#/join?room=...`), which GitHub Pages serves correctly without
rewrite rules. The workflow also copies `index.html` to `404.html` as a safety net.

### Deploying the room worker (one-time Cloudflare setup)

The game needs its room server. Setting it up takes about ten minutes, once. Everything below
still says _relay_ — the workflow, the worker's name, the repository variable — because that
is what it was before the game moved into it, and renaming any of it would break a deployment
that works. It is the room worker; only the label is historical.

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com) — no credit
   card required.
2. Copy the **Account ID** from the dashboard's overview page.
3. Create an API token: My Profile → API Tokens → Create Token → the **Edit Cloudflare
   Workers** template.
4. Add both as repository **Secrets** (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Push to the default branch (or run the `Deploy relay worker` workflow manually). The run
   summary prints the worker's URL.
6. Set the repository **Variable** `RELAY_URL` to that URL with a `wss://` scheme, e.g.
   `wss://supertaki-relay.<your-subdomain>.workers.dev`, and re-run the Pages deploy.

The Pages build injects `RELAY_URL` into the app (`VITE_RELAY_URL`) and into the Content
Security Policy, so the deployed page can talk to exactly one room server: yours. Locally, no
configuration is needed — `npm run dev` in `worker/` serves it on `ws://127.0.0.1:8787`,
which is the dev build's default.

## The room server (read this)

This is the honest part.

- **The game runs on the server.** A move is a few hundred bytes over a TLS WebSocket to the
  room's Durable Object, which validates it against the rules and sends the table back out.
  The object holds every hand, the deck and the random state. Read that sentence twice if you
  care about privacy — it is the trade the next bullet is about.
- **The operator can see the cards; no player can.** Whoever holds the Cloudflare account —
  the person who deployed this — could inspect a room's storage. Every player sees only their
  own hand. That is a deliberate swap: the game used to run in the room creator's _tab_, so
  the authority was one of the players, and a determined one could deal themselves a good
  hand. Hands are deleted six hours after the last player leaves. Full account in
  [docs/threat-model.md](docs/threat-model.md) §11.
- **The room is a single free-plan worker.** If Cloudflare has an outage, the game has an
  outage; the app says so and retries with backoff. The free plan's limits are generous
  (100,000 requests a day) and a game evening does not approach them.
- **Anybody can vanish, including whoever opened the room.** Close the tab, lose the phone,
  run out of battery — reopen the site and tap "Rejoin". The table is exactly where you left
  it. There is nothing to reclaim and nothing for anybody else to do; the room kept playing
  without you.
- **A disconnect is a pause, not the end.** A seat is held for five minutes, the table says
  who it is waiting for and counts down, and the game keeps moving around the empty chair
  rather than freezing on it. Any player can ask the table to wait, and a table that cannot
  sensibly continue can agree to end the round with no winner.
- Expect a room to work anywhere a normal website works, including corporate and school
  networks and cellular. There is no NAT traversal, no STUN, no TURN and no WebRTC anywhere —
  the failure modes of the peer-to-peer era do not apply.

## Privacy

- No accounts, no logins, no email, no analytics, no telemetry, no cookies.
- Game data travels between each player and the room, encrypted in transit by TLS. The room
  is code you deploy to your own free Cloudflare account (`worker/`).
- **The room holds every hand while the game is running**, because it is the thing enforcing
  the rules. Its storage is deleted six hours after the last player leaves. Whoever runs the
  Cloudflare account can read it; no player can. See
  [docs/threat-model.md](docs/threat-model.md) §11.
- Your hand is private _from the other players_: the room sends each socket only that seat's
  cards. Everyone else sees card _counts_.
- Nothing about the game is written to your device. `localStorage` holds only: chosen
  language, theme, your display name, and — while a room is live — a room code, seat id and
  rejoin token that expire after 6 hours. Nothing else, ever. "Start fresh" on the home
  screen erases it immediately.
- A room code is an invitation, not a password: six digits, so a typo lands nowhere, but
  anyone who has the link or the code can try to join while the room is open. Share it only
  with people you want at the table.
- Display names are visible to everyone in the room. They are trimmed to 16 characters and
  stripped of invisible and direction-flipping characters.

## Browser compatibility

Recent Chrome, Edge, Firefox and Safari (desktop, Android and iOS) — anything with
WebSockets, which is to say everything this decade. iOS Safari 15+ is fine.

- WebSocket support is checked at start-up; an unsupported browser gets a clear message
  rather than a broken screen.
- The layout is tested down to 320 px wide and honours `prefers-reduced-motion`,
  `prefers-color-scheme` and the system font stack (no web-font downloads).
- Keep the game tab in the foreground. Mobile browsers aggressively suspend background
  tabs, which can drop the connection — the app will try to reconnect when you return.

## Troubleshooting

| Symptom                                | What it means and what to do                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The room is closed"                   | Wrong room code, or the room has been empty for more than six hours and was deleted. Check the code; otherwise open a new room.                    |
| "The connection to the room failed"    | Check your internet connection and retry. If it persists, check the worker's status in the Cloudflare dashboard.                                   |
| "That room code is in use"             | A rare collision. The app draws another code by itself; if it surfaces, just create the room again.                                                |
| "Create game" spins with no room code  | The room server is not answering. On a fresh deployment, make sure `RELAY_URL` is set and the `Deploy relay worker` workflow has run — see above.  |
| Stuck on "Reconnecting…"               | The tab may have been suspended. Bring it to the foreground; the app retries with backoff.                                                         |
| Your browser crashed or the tab closed | Open the site again on the same device and tap "Rejoin" — same seat, same cards. The offer lasts six hours, and the others kept playing meanwhile. |
| Blank page after deploying             | Almost always a wrong `base` path — see [docs/deployment.md](docs/deployment.md).                                                                  |
| Need diagnostics                       | Append `?debug=1` to the URL and open the browser console.                                                                                         |

## Repository layout

```
src/
  app/                     app shell, top bar, settings, error boundary, live region, routing
  components/              design system: button, icon set, callout, badge, field, modal, segmented
  features/game/
    engine/                pure rules: cards, deck, seeded PRNG, reducer, views
    network/               protocol schemas, the room socket, the client session
    state/                 Zustand store, selectors, local persistence
    ui/                    screens and game components
  i18n/                    Hebrew and English dictionaries
  lib/                     ids, sanitising, storage, clipboard, QR encoder, focus trap, logger
  styles/                  tokens, base, components, cards, screens
worker/                    the room: Cloudflare Worker + one Durable Object per room, and the game
docs/                      architecture, protocol, rules, QA, UI review, threat model, deployment
tests/
  unit/                    engine, protocol, the client session, store, i18n, lib
  component/               React Testing Library screens
  e2e/                     Playwright scenarios
.github/workflows/         CI and GitHub Pages deployment
```

The separation is deliberate: `engine/` has no DOM and no network imports, `network/` has
no UI imports, and the UI holds no game rules.

## Documentation

- [docs/architecture.md](docs/architecture.md) — static hosting constraints, server authority, data flow, reconnection, limitations
- [docs/server-game-plan.md](docs/server-game-plan.md) — why the game moved into the room, and what that deleted
- [docs/protocol.md](docs/protocol.md) — message envelope, every message type, validation, versioning, examples
- [docs/rules.md](docs/rules.md) — exact deck, exact rules, +2 runs, the King, the +3 breaker window, decisions where editions disagree (bilingual)
- [docs/robots.md](docs/robots.md) — robot players: what they know, how they play, when one covers a human seat
- [docs/threat-model.md](docs/threat-model.md) — what a malicious client can and cannot do, and what the operator can see
- [docs/deployment.md](docs/deployment.md) — GitHub Pages step by step
- [docs/qa-report.md](docs/qa-report.md) — what was tested, coverage, manual checklist, known limitations
- [docs/review-notes.md](docs/review-notes.md) — findings from the expert review passes and the changes made
- [docs/ui-review.md](docs/ui-review.md) — the interface pass: what was wrong with the UI/UX and what changed

## Disclaimer

This is a **private, unofficial** hobby project. It is **not affiliated with, endorsed by,
or connected to Shafir Games or any other publisher of Taki.** Taki is their trademark.

Every asset in this repository — the card symbols, the wordmark, the icons and the
wording — is drawn from scratch in CSS and inline SVG for this project. No artwork, logo,
brand asset, font or packaging design from the published game is used or reproduced. What
is shared with the published game is the ruleset, which is not itself copyrightable and is
documented in full in [docs/rules.md](docs/rules.md).

## Licence

MIT — see [LICENSE](LICENSE).
