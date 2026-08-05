# Super Taki

**A private game of Taki — in the browser, at exactly zero cost.**

Super Taki is a mobile-first multiplayer card game for 2–6 players. One person opens a
room and shares it however suits the room they are in — a link, a six-digit code, or the QR
code on their screen — and everyone else joins from their own phone, tablet or laptop.
There is no account, no database and no paid service anywhere in the stack: the site is
static files on GitHub Pages, and game traffic flows through a tiny WebSocket relay — one
Durable Object per room on Cloudflare's free plan — that routes frames between the players
and knows nothing about the game.

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
- [The relay](#the-relay-read-this)
- [Privacy](#privacy)
- [Browser compatibility](#browser-compatibility)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Disclaimer](#disclaimer)
- [Licence](#licence)

---

## Zero-cost architecture

| Concern               | How it is solved                                              | Cost                        |
| --------------------- | ------------------------------------------------------------- | --------------------------- |
| Hosting               | Static build on GitHub Pages                                  | Free                        |
| Multiplayer transport | WebSocket frames routed by the room's relay (`worker/`)       | Free (Cloudflare free plan) |
| Room registry         | One Durable Object per room code, hibernating between moves   | Free                        |
| Game state            | Held in the host player's browser tab                         | Free                        |
| Accounts / identity   | None; a random local id and a display name                    | Free                        |
| Persistence           | `localStorage` for preferences, a rejoin token, host snapshot | Free                        |
| Analytics / telemetry | None at all                                                   | Free                        |

The relay is yours: about two hundred lines of TypeScript in `worker/`, deployed to a free
Cloudflare account with no credit card. A full game evening uses well under one percent of
the free plan's daily allowance. There is no NAT traversal, no STUN, no TURN and no WebRTC
anywhere — the failure modes that plagued the earlier peer-to-peer design (networks that
never connect, iPhones dropping the connection on every screen lock, reconnects that never
land) are gone with them. What remains is described in [The relay](#the-relay-read-this).

**One player is the host.** The room creator's tab owns the only complete copy of the game
state, validates every move, and sends each player their own hand plus the public table.
Other players send _intents_ ("play this card"), never state. See
[docs/architecture.md](docs/architecture.md).

## Quick start

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
npm run dev
```

Open the printed URL. To try multiplayer on one machine, open a second tab with
`?transport=broadcast` on **both** tabs — that swaps the relay for a `BroadcastChannel`
between tabs of the same browser:

```
http://localhost:5173/?transport=broadcast
```

Create a room in the first tab, copy the room code, and join from the second.

Requirements: Node.js 20+ (CI uses 22) and npm 10+.

## npm scripts

| Script                            | What it does                                       |
| --------------------------------- | -------------------------------------------------- |
| `npm run dev`                     | Vite dev server with hot reload                    |
| `npm run build`                   | Typecheck (`tsc -b`) then produce `dist/`          |
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
- `?transport=broadcast` switches to the same-browser transport described above. It is
  also genuinely useful for playing on one device with two windows.

## Running the tests

```bash
npm test                # 669 unit + component tests
npm run test:coverage   # same, with coverage thresholds enforced
npm run test:e2e        # 28 scenarios x 2 viewports (needs a Chromium download once)
```

Playwright downloads Chromium on first use (`npx playwright install chromium`). If your
environment already has a Chromium build, point Playwright at it instead:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e
```

The end-to-end suite drives two real pages through the production bundle over the
`BroadcastChannel` transport, which keeps CI deterministic. The real network path is
covered separately: `npm run smoke` inside `worker/` starts the actual relay under
`wrangler dev` and drives real WebSocket clients through registration, claim arbitration,
routing, presence and host reclaim. Everything above the transport — the protocol, host
authority, the engine and the UI — is the same code path in both.

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

### Deploying the relay (one-time Cloudflare setup)

The game needs its relay. Setting it up takes about ten minutes, once:

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
Security Policy, so the deployed page can talk to exactly one relay: yours. Locally, no
configuration is needed — `npm run dev` in `worker/` serves the relay on
`ws://127.0.0.1:8787`, which is the dev build's default.

## The relay (read this)

This is the honest part.

- **All game traffic passes through the relay.** A move is a few hundred bytes over a TLS
  WebSocket to a Cloudflare Durable Object and out to the other players. The relay routes
  frames by peer id and reads none of them; the host's browser is still the only authority
  on the game. This replaced WebRTC peer-to-peer wholesale, because in practice WebRTC
  failed exactly where people play: phones on cellular, iPhones locking their screen,
  networks that block UDP. A `wss://` connection on port 443 works everywhere the web does.
- **The relay is a single free-plan worker.** If Cloudflare has an outage, the game has an
  outage; the app says so and retries with backoff. The free plan's limits are generous
  (100,000 requests a day) and a game evening does not approach them.
- **The host's tab is the game — and it can always come back.** The host's room, including
  every hand and the deck, is snapshotted to the host device's local storage, and the room's
  claim travels with it. Reloading, closing the tab, or a crashed browser all recover the
  same way: reopen the site, tap "resume", and the relay hands back the _same room code_ —
  every invite already sent still works, every guest's stored credential still fits, and
  the guests, who never lost their relay connection, see the host return. The snapshot
  expires after six hours and is erased the moment the host leaves on purpose. A host who
  has to go can also hand the room to another player mid-round.
- **A disconnect is a pause, not the end.** A seat is held for five minutes, the table says
  who it is waiting for and counts down, and the game keeps moving around the empty chair
  rather than freezing on it. Any player can ask the table to wait, and a table that cannot
  sensibly continue can agree to end the round with no winner.
- **A player who refreshes can rejoin.** Their browser keeps a seat id and a rejoin token,
  and the host restores their hand and the table. If the token is stale, they are offered a
  fresh join instead.
- Expect a room to work anywhere a normal website works, including corporate and school
  networks and cellular — the failure modes of the peer-to-peer era do not apply.

## Privacy

- No accounts, no logins, no email, no analytics, no telemetry, no cookies.
- Game data travels between the players through the room's relay, encrypted in transit by
  TLS. The relay is code you deploy to your own free Cloudflare account (`worker/`); it
  routes frames between peer ids without parsing game payloads, and stores nothing but
  which peer ids belong to a room, forgotten six hours after the room empties.
- The host's device keeps a snapshot of the running game (including every hand) in its
  local storage so the game survives a crash; it expires after six hours and is erased on
  an intentional leave.
- Your hand is private: the host sends each player only their own cards. Everyone else sees
  card _counts_.
- `localStorage` holds only: chosen language, theme, your display name, and — while a room
  is live — a room code, host peer id, seat id and rejoin token that expire after 6 hours.
  Nothing else, ever. "Start fresh" on the home screen erases it immediately.
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

| Symptom                                  | What it means and what to do                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The host could not be reached"          | Wrong room code, or the host has been away too long. Check the code; if the host crashed, they can resume from their own device and everyone reconnects. |
| "The relay could not be reached"         | The relay is unreachable — check your internet connection and retry. If it persists, check the worker's status in the Cloudflare dashboard.              |
| "That room code is already taken"        | Rare collision (or you already host a room in another tab). Create a new room.                                                                           |
| "Create game" spins with no room code    | The relay is not answering. If this is a fresh deployment, make sure `RELAY_URL` is set and the `Deploy relay worker` workflow has run — see above.      |
| Stuck on "Reconnecting…"                 | The tab may have been suspended. Bring it to the foreground; the app retries with backoff.                                                               |
| Host's browser crashed or the tab closed | Open the site again on the same device and tap "resume the room" — same code, everyone reconnects. The offer lasts six hours.                            |
| Blank page after deploying               | Almost always a wrong `base` path — see [docs/deployment.md](docs/deployment.md).                                                                        |
| Need diagnostics                         | Append `?debug=1` to the URL and open the browser console.                                                                                               |

## Repository layout

```
src/
  app/                     app shell, top bar, settings, error boundary, live region, routing
  components/              design system: button, icon set, callout, badge, field, modal, segmented
  features/game/
    engine/                pure rules: cards, deck, seeded PRNG, reducer, views
    network/               protocol schemas, transports, host and client sessions
    state/                 Zustand store, selectors, local persistence
    ui/                    screens and game components
  i18n/                    Hebrew and English dictionaries
  lib/                     ids, sanitising, storage, clipboard, QR encoder, focus trap, logger
  styles/                  tokens, base, components, cards, screens
worker/                    the room relay: Cloudflare Worker + one Durable Object per room
docs/                      architecture, protocol, rules, QA, UI review, threat model, deployment
tests/
  unit/                    engine, protocol, sessions, store, i18n, lib
  component/               React Testing Library screens
  e2e/                     Playwright scenarios
.github/workflows/         CI and GitHub Pages deployment
```

The separation is deliberate: `engine/` has no DOM and no network imports, `network/` has
no UI imports, and the UI holds no game rules.

## Documentation

- [docs/architecture.md](docs/architecture.md) — static hosting constraints, host authority, data flow, reconnection, limitations
- [docs/protocol.md](docs/protocol.md) — message envelope, every message type, validation, versioning, examples
- [docs/rules.md](docs/rules.md) — exact deck, exact rules, +2 runs, the King, the +3 breaker window, decisions where editions disagree (bilingual)
- [docs/threat-model.md](docs/threat-model.md) — what a malicious peer can and cannot do
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
