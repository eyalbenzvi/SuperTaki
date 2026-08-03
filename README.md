# Super Taki

**A private game of Taki — peer-to-peer, in the browser, at exactly zero cost.**

Super Taki is a mobile-first multiplayer card game for 2–6 players. One person opens a
room, shares a link or a room code, and everyone else joins from their own phone, tablet
or laptop. There is no server, no account, no database and no paid service anywhere in the
stack: the site is static files on GitHub Pages, and the players' browsers talk directly
to each other over WebRTC data channels.

The interface is Hebrew by default (right-to-left) with an English toggle. The deck is the
full Super Taki deck — numbers, Stop, Plus, +2, Change Direction and Taki in four colours,
plus Change Colour, Super Taki, King, +3 and the +3 Breaker. The exact rules the engine
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
- [PeerJS / WebRTC limitations](#peerjs--webrtc-limitations-read-this)
- [Privacy](#privacy)
- [Browser compatibility](#browser-compatibility)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Disclaimer](#disclaimer)
- [Licence](#licence)

---

## Zero-cost architecture

| Concern                         | How it is solved                                  | Cost             |
| ------------------------------- | ------------------------------------------------- | ---------------- |
| Hosting                         | Static build on GitHub Pages                      | Free             |
| Multiplayer transport           | WebRTC data channels between browsers (PeerJS)    | Free             |
| Signalling (finding each other) | The public PeerJS broker                          | Free, no account |
| NAT traversal                   | Public STUN servers (Google, Cloudflare)          | Free             |
| Game state                      | Held in the host player's browser tab             | Free             |
| Accounts / identity             | None; a random local id and a display name        | Free             |
| Persistence                     | `localStorage` for preferences and a rejoin token | Free             |
| Analytics / telemetry           | None at all                                       | Free             |

Nothing in this project requires billing information, a subscription, a serverless
function or a database. The trade-offs that buys are described honestly in
[PeerJS / WebRTC limitations](#peerjs--webrtc-limitations-read-this).

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
`?transport=broadcast` on **both** tabs — that swaps WebRTC for a `BroadcastChannel`
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
npm test                # 456 unit + component tests
npm run test:coverage   # same, with coverage thresholds enforced
npm run test:e2e        # 20 scenarios x 2 viewports (needs a Chromium download once)
```

Playwright downloads Chromium on first use (`npx playwright install chromium`). If your
environment already has a Chromium build, point Playwright at it instead:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e
```

The end-to-end suite drives two real pages through the production bundle. It uses the
`BroadcastChannel` transport rather than live WebRTC, because public signalling servers and
NAT traversal cannot be made deterministic in CI. Everything above the transport — the
protocol, host authority, the engine and the UI — is the real code path. This limitation is
recorded in [docs/qa-report.md](docs/qa-report.md).

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

### Optional: your own PeerServer or TURN

Not required, and not free if you self-host — but the app is built for it. Set these as
repository **Variables** (Settings → Secrets and variables → Actions → Variables) and the
deploy workflow will pass them through:

| Variable           | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `VITE_PEER_HOST`   | Your PeerServer hostname (enables the whole block)       |
| `VITE_PEER_PORT`   | Port (default 443 when secure)                           |
| `VITE_PEER_PATH`   | Path (default `/`)                                       |
| `VITE_PEER_SECURE` | `false` for plain HTTP/WS                                |
| `VITE_PEER_KEY`    | PeerServer key, if you set one                           |
| `VITE_ICE_SERVERS` | JSON array of `RTCIceServer` entries, e.g. a TURN server |

If you add a host or TURN server, extend the `connect-src` list in the Content Security
Policy in `index.html` to match.

## PeerJS / WebRTC limitations (read this)

This is the honest part.

- **GitHub Pages cannot run a signalling server.** Static hosting serves files; it cannot
  hold WebSocket connections. Peers therefore find each other through the free public
  PeerJS broker. That service is generously provided, best-effort, and can be slow or
  briefly unavailable. When it is, the app says so and offers a retry.
- **Some networks block direct peer-to-peer connections.** STUN lets two browsers discover
  their public addresses, but it cannot relay traffic. Behind symmetric NAT — common on
  corporate, school and some mobile networks — a direct connection simply cannot be
  established. The reliable fix is a TURN relay, which costs money and would break the
  zero-cost rule, so **this app does not include one.** When a connection fails, the UI
  explains why and suggests what actually works: a different network (home Wi-Fi, a phone
  hotspot) or playing on one device with two windows.
- **Fully reliable global connectivity is not possible under these constraints.** Nothing
  in this project pretends otherwise.
- **The host's tab is the game.** If the host closes the page or loses connection
  permanently, the room ends. Host migration is _not_ implemented: transferring authority
  correctly would need the departing host's private state, which it cannot hand over once
  it is gone. Rather than fake it, the app tells everyone plainly that the room is over.
- **A player who refreshes can rejoin.** Their browser keeps a seat id and a rejoin token,
  and the host restores their hand and the table. If the token is stale, they are offered a
  fresh join instead.
- Expect a room to work well between phones on the same Wi-Fi, between home networks, and
  over most consumer internet connections. Expect trouble on locked-down corporate Wi-Fi.

## Privacy

- No accounts, no logins, no email, no analytics, no telemetry, no cookies.
- Game data travels directly between the players in your room, encrypted in transit by
  WebRTC (DTLS/SRTP). It does not pass through this project's infrastructure — there is
  none. The signalling broker sees connection metadata (peer ids), not game content.
- Your hand is private: the host sends each player only their own cards. Everyone else sees
  card _counts_.
- `localStorage` holds only: chosen language, theme, your display name, and — while a room
  is live — a room code, host peer id, seat id and rejoin token that expire after 6 hours.
  Nothing else, ever. "Start fresh" on the home screen erases it immediately.
- A room code is an invitation, not a password. Anyone who has the link can try to join
  while the room is open, so share it only with people you want at the table.
- Display names are visible to everyone in the room. They are trimmed to 16 characters and
  stripped of invisible and direction-flipping characters.

## Browser compatibility

Recent Chrome, Edge, Firefox and Safari (desktop, Android and iOS) — anything with WebRTC
data channels, which has been standard since roughly 2018. iOS Safari 15+ is fine.

- WebRTC support is probed at start-up; an unsupported browser gets a clear message rather
  than a broken screen.
- The layout is tested down to 320 px wide and honours `prefers-reduced-motion`,
  `prefers-color-scheme` and the system font stack (no web-font downloads).
- Keep the game tab in the foreground. Mobile browsers aggressively suspend background
  tabs, which can drop the connection — the app will try to reconnect when you return.

## Troubleshooting

| Symptom                                            | What it means and what to do                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The host could not be reached"                    | Wrong room code, or the host closed their tab. Check the code and that the host still has the page open.                                                                                              |
| "The free connection service could not be reached" | The public PeerJS broker is unreachable. Check your internet connection and retry.                                                                                                                    |
| Connection fails on a company or school network    | That network is probably blocking peer-to-peer traffic. Try a phone hotspot or home Wi-Fi. There is no relay server, by design.                                                                       |
| "That room code is already taken"                  | Rare collision (or you already host a room in another tab). Create a new room.                                                                                                                        |
| "Create game" spins with no room code              | The free signalling service is not responding. The app now gives up after 20 s with an explanation; if it persists the public broker is down — retry later, or configure your own PeerServer (above). |
| Stuck on "Reconnecting…"                           | The tab may have been suspended. Bring it to the foreground; the app retries with backoff.                                                                                                            |
| Game ends unexpectedly for everyone                | The host left. Under this server-free design the room cannot continue.                                                                                                                                |
| Blank page after deploying                         | Almost always a wrong `base` path — see [docs/deployment.md](docs/deployment.md).                                                                                                                     |
| Need diagnostics                                   | Append `?debug=1` to the URL and open the browser console.                                                                                                                                            |

## Repository layout

```
src/
  app/                     app shell, top bar, hash routing, translator hook
  components/              generic UI (accessible modal, segmented control)
  features/game/
    engine/                pure rules: cards, deck, seeded PRNG, reducer, views
    network/               protocol schemas, transports, host and client sessions
    state/                 Zustand store, selectors, local persistence
    ui/                    screens and game components
  i18n/                    Hebrew and English dictionaries
  lib/                     ids, sanitising, storage, clipboard, focus trap, logger
  styles/                  tokens, base, components, cards, screens
docs/                      architecture, protocol, rules, QA, threat model, deployment
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
