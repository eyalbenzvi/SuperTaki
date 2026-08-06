# QA report

> **Records an earlier architecture.** The findings below were made when the game ran in the
> room creator's browser tab. The game now runs in the room's Durable Object; see
> [server-game-plan.md](server-game-plan.md). Everything here about the _rules_, the UI and
> the engine still holds — what has moved is where the authority lives.

> **Note.** This document records the review of the pre-rebrand version of this app, when
> it was called Color Rush and shipped a 110-card deck and an in-app rules page. The rebrand
> to Super Taki added the +2, King, +3 and +3 Breaker cards, dropped the rules page, and
> changed Super Taki to take the leading colour instead of choosing one. Findings about the
> parts that did not change still stand; anything below that mentions the old name, the old
> deck size or the rules page describes the version that was reviewed, not the current one.

**Status: ready to deploy.** All automated checks pass, and the issues found during testing
and review were fixed rather than documented as quirks. Remaining limitations are inherent to
the zero-cost architecture and are listed at the end.

Date of this run: after the review passes recorded in [review-notes.md](review-notes.md) and the
interface pass recorded in [ui-review.md](ui-review.md).

## Commands run and results

| Command                 | Result                                                               |
| ----------------------- | -------------------------------------------------------------------- |
| `npm run format:check`  | ✅ pass — Prettier clean across source, tests and docs               |
| `npm run lint`          | ✅ pass — 0 errors, 0 warnings (ESLint, type-aware rules)            |
| `npm run typecheck`     | ✅ pass — TypeScript strict, project references, 0 errors            |
| `npm test`              | ✅ **510 tests in 31 files** pass                                    |
| `npm run test:coverage` | ✅ pass — thresholds met (below)                                     |
| `npm run build`         | ✅ pass — `dist/` ≈ 479 kB JS (141 kB gzip), 33 kB CSS (7.4 kB gzip) |
| `npm run test:e2e`      | ✅ **35 tests** pass (18 scenarios × desktop + mobile, 1 skipped)    |
| `npm audit --omit=dev`  | ✅ 0 vulnerabilities in production dependencies                      |
| `npm audit` (all)       | ✅ 0 vulnerabilities                                                 |

TypeScript is strict with `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noUnusedLocals` and `noUnusedParameters`. There is no `any` in
`src/`.

## Coverage

Enforced thresholds (`vitest.config.ts`) — the build fails if these regress:

| Area                              | Statements | Branches | Functions | Lines    |
| --------------------------------- | ---------- | -------- | --------- | -------- |
| `engine/**` (threshold)           | ≥ 95       | ≥ 90     | ≥ 95      | ≥ 95     |
| `engine/**` (actual)              | **99.6**   | **94.7** | **100**   | **99.6** |
| `network/protocol.ts` (threshold) | ≥ 90       | ≥ 85     | ≥ 85      | ≥ 90     |
| `network/protocol.ts` (actual)    | **100**    | **94.7** | **100**   | **100**  |

Whole project: **87.0 % statements, 78.7 % branches, 88.0 % functions, 86.5 % lines.**

Where coverage is deliberately lower:

| File                                 | Coverage | Why                                                                                                                                                                         |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broadcastTransport.ts`              | excluded | Thin wrapper over `BroadcastChannel`; the end-to-end suite uses it as its transport, so it is covered there rather than by a mock of itself.                                |
| `peerConfig.ts`                      | 5 %      | Reads build-time `import.meta.env`, which is fixed per bundle. Verified manually with and without the variables set.                                                        |
| `transportFactory.ts`                | 0 %      | Three-line switch; the store tests replace it with the memory transport by design, and end-to-end tests exercise the real branch.                                           |
| `clientSession.ts`, `hostSession.ts` | ~80 %    | Uncovered lines are timer-driven heartbeat/backoff branches after long silences. Exercised in manual testing (see below); simulating them would mean testing `setInterval`. |
| `logger.ts`                          | 46 %     | The `?debug=1` sticky-flag path, checked manually.                                                                                                                          |
| `useFocusTrap.ts`                    | 70 %     | Edge branches (a dialog with no focusable child). The real behaviour — trap, escape, restore — is covered by component tests.                                               |

## Test suites

Exact counts per file (from `vitest --reporter=json`):

```
 121  tests/unit/engine/*         deck, prng, setup, matching, commands, specialCards,
                                  taki, drawPile, win, views
 126  tests/unit/network/*        protocol, envelope, roomCode, sessions, clientSession
  54  tests/unit/state/*          persistence, selectors, storeFlow
  36  tests/unit/lib/*            sanitize, storage, misc (ids, logger, share)
  21  tests/unit/ui/*             cardText, eventText
  14  tests/unit/i18n.test.ts     dictionary parity and interpolation
  96  tests/component/*           landing, forms, lobby, game, gameOver, table
 ----
 510  total
```

The `table` file and the additions elsewhere came with the interface pass: the hand as a keyboard
widget, the move-in-flight lock, the single action prompt and its priority order, seat status,
offline and reconnecting wording, and the one leave confirmation. See
[ui-review.md](ui-review.md).

### Layout, measured rather than eyeballed

The whole journey was driven on two pages at 320×568, 390×844, 430×932, 844×390 (landscape),
820×1180 and 1280×900, in Hebrew and English and in both themes, asserting programmatically at
every screen that:

- the document never scrolls horizontally;
- no element is clipped outside the viewport or outside a scroll container of its own;
- no interactive target is under 36 px tall or 24 px wide;
- the console produces no errors or warnings.

The game screen additionally never scrolls vertically at any of those sizes — the hand, the
prompt and the turn banner are always on screen — which is the property the fixed-height table
layout exists to guarantee. Long display names (28 characters) were driven through the same
sweep.

### Unit — game engine (`tests/unit/engine/`, 121 tests)

- **Deck**: 110 cards, unique ids, exact per-colour counts, stable build order, colour/symbol helpers.
- **Seeded PRNG**: reproducibility, range, permutation, no input mutation, state advance, empty/single input.
- **Setup**: player-count limits, duplicate ids, 8-card deal for 2–6 players, deck conservation, number card face up, determinism per seed, JSON round trip, continuing a version sequence.
- **Matching**: colour match, number match, action-symbol match across colours, wilds always legal, no-top-card fallback, chosen colour after a wild, all Taki-mode restrictions.
- **Turn order**: forwards, backwards, wrapping, two-seat behaviour, empty-table guard.
- **Special cards**: Stop (3-player skip, 2-player return, reversed direction), Plus (obligation, forbidden draw, allowed draw with nothing legal, chaining), Change Direction (both directions, 2-player), Colour Change.
- **Taki**: opening, playable subset, consecutive plays, wrong colour, wild rejected, draw rejected, effects deferred, Taki-on-Taki, closing with each trailing card type, closing with an empty pile.
- **Super Taki**: colour required, invalid colour, sequence in the chosen colour, single-card sequence.
- **Draw pile**: recycling keeps the top card, conserves every card id, is deterministic, advances the RNG; exhaustion passes the turn; a Plus obligation lapses when nothing can be drawn.
- **Win detection**: last card, on a Plus, on a Taki, inside a sequence, on a wild; the game locks afterwards.
- **Views**: public state exposes counts only, private hand isolation, standings with ties, rule context parity between host and client.
- **Immutability**: input state is asserted unchanged after every command; the version increments exactly once.

### Unit — network (`tests/unit/network/`, 126 tests)

- **Schema validation**: every message type accepted; primitives, arrays, `null`, missing envelope fields, unknown types, bad payloads, over-long names, oversized and cyclic messages all rejected with the right code.
- **Direction**: a host-only message on the host's inbound path is rejected, and vice versa.
- **Extra fields**: unknown payload keys are stripped, not trusted.
- **Envelope**: schema-valid output, unique ids across 200 messages, injectable clock.
- **De-duplication**: repeats dropped, LRU eviction at capacity, reset.
- **Room codes**: generation validity and variety, no repeated word, normalisation of sloppy input, validation, peer-id derivation, invite build/parse round trip, invalid host override ignored, transport override preserved.
- **Sessions over a mock transport** (32 tests): seating, name de-duplication, hostile-name sanitising, room full, player limits, table language, kicking, leaving, host departure, start requirements, private deals, public card counts, shared events, host and client actions, out-of-turn rejection, unknown card, playing a card you do not hold, late joins refused, reconnection with hand restore, wrong/unknown resume rejection, **a complete round played to a winner**, play-again voting and a fresh deal with continuing versions.
- **Hostile traffic**: malformed messages, protocol mismatch, wrong room, replay, duplicate connections, actions from a peer that never joined.
- **PeerJS wrapper** (13 tests, against a fake `Peer`): id assigned on `open`; **a broker that
  accepts the socket and never opens is abandoned after a deadline**; no spurious timeout after a
  successful open; all seven PeerJS error types mapped; a late error does not un-resolve `ready()`;
  peer destroyed on teardown; refusal without WebRTC support.
- **Client behaviour** (22 tests): join handshake, fail-fast on an absent room, stale snapshot dropped, equal version accepted, another player's hand ignored, out-of-order hand dropped, replay dropped, wrong room ignored, protocol mismatch reported, malformed ignored, ping/pong, event forwarding, kick and host-closed handling, no auto-retry after a definitive rejection, manual retry, intents carry no player id, leave announced, idempotent destroy.

### Unit — state, i18n, lib, UI text (`tests/unit/`, 125 tests)

- **Store integration** (19 tests, real sessions over the memory transport): room creation with invite link, no resume token for the host, retry on a taken code, signalling failure surfaced, concurrent create ignored, host controls, join with resume metadata stored, transition to the game screen with a private hand, rejection notices with fresh nonces, closed-room handling, unreachable room, full teardown on leave, preferences persisted and applied, rules navigation, no-session safety.
- **Selectors** (17 tests): roles, identity, turn logic, legal cards, opponent ordering from every seat, seat-less viewer, health, standings, winner.
- **Persistence** (17 tests): defaults, round trips, invalid stored values, TTL expiry, future timestamps, six malformed shapes, clearing, exact stored key set, theme/direction application.
- **i18n** (14 tests): key parity between Hebrew and English, no empty strings, placeholder parity, a message for every rejection code, connection phase, session error and close reason; interpolation; fallback; product name is not "Super Taki".
- **Event text** (21 tests): every one of the 13 event types in English and Hebrew, no unresolved placeholders, and an assertion that only `cardPlayed` names a card.
- **Lib**: sanitising (Hebrew and Latin names, whitespace, control characters, bidi overrides, zero-width marks, truncation, unusable input, markup left inert), uniquifying, storage (namespacing, JSON validation, throwing storage, unserialisable values), ids (format, uniqueness, bounded integers, rejection sampling), logger (silent by default, errors always), clipboard and Web Share (async path, legacy fallback, total failure, cancellation).

### Component (`tests/component/`, 82 tests)

React Testing Library against the real store, driven through the real `App`.

- **Landing**: Hebrew title and entry points, connectivity and privacy notes, language switch with document direction, theme switch, arrow-key navigation in the segmented control, navigation, rules page round trip, resume offer, skip link, labelled top-bar controls.
- **Create form**: name required, sanitised submission with chosen options, `maxlength`, busy state, **failure surfaced on the create screen**, taken-code message, 2–6 range only.
- **Join form**: invalid code rejected, bare code accepted, full invite link with custom host, both errors at once, prefill and announcement from a link, resume with stored credentials.
- **Lobby**: room code, invite link and a QR code of that link, seat order with host/self markers, player count, per-player health, host-only removal, direct start when all connected, confirmation when unstable, disabled below two players, guest view, leave confirmation with host warning, max-player control.
- **Invite sharing**: clipboard success and confirmation, failure explained, native share sheet, share button hidden without the API.
- **Connection notices**: quiet when connected, reconnection notice, honest failure with a retry for retryable errors, no retry for non-retryable, closed-room dialog, silence after a voluntary leave.
- **Game**: opponent shown face down with a count, colour/direction/turn indicators, legal-card enablement, symbol match, whole hand disabled off-turn, engine parity, play forwarding, draw pile states (on turn, off turn, during Taki), "draw" hint, colour picker for both wild cards with cancel/Escape/focus-trap/focus-restore, Taki banner and Close Taki, sequence-colour restriction, close hidden from non-owners, Plus notice, game log without private information, rejection toast with a colour-aware message, compact rules drawer, leave confirmation, waiting state.
- **End of round**: winner named, standings ordered with the local marker, self-congratulation, vote and progress, vote withdrawal, no-persistence statement, return home.

### End-to-end (`tests/e2e/`, 20 scenarios × 2 viewports = 40)

Real production bundle served by `vite preview`, driven by Chromium at desktop (1280×720) and
mobile (Pixel 5) sizes.

- **Landing** (9): Hebrew RTL default, English switch and back, language persisted across reload, theme switch persisted, connectivity/privacy/disclaimer text, rules page and return, `#/rules` deep link, keyboard-only navigation from the skip link to starting a room, **no horizontal overflow and ≥44 px targets at 320 px wide**.
- **Multiplayer** (10, two real pages): create and join by code then start, join via invite link with the hash cleared afterwards, **hands stay private in rendered HTML**, play a card and see it on both sides, draw and pass the turn, hand and draw pile disabled off-turn, host removes a player, host leaves and the guest is told the room is closed, third player refused in a two-player room, unreachable room reported honestly with the peer-to-peer explanation.
- **Full round** (1): two bot-driven players play a complete round — hundreds of host-validated commands including special cards, Taki sequences, wild colour choices and draw-pile recycling — reach a winner, verify exactly one player finished on zero cards, see the "nothing is saved" statement, then both vote and a fresh round is dealt.

**Documented limitation:** the end-to-end suite uses the `BroadcastChannel` transport
(`?transport=broadcast`), not live WebRTC. Public signalling and NAT traversal are not
deterministic and would make CI flaky, hiding real regressions. Everything above the transport
— protocol, validation, host authority, engine, store, UI — is the production code path. Real
WebRTC is covered by the manual checklist below.

> **No longer true, and worth saying where it was claimed.** There is no WebRTC, no
> BroadcastChannel transport and no host authority left. The end-to-end suite now drives two
> real browser pages against the real room under `wrangler dev`, which is the production path
> without the domain name — so the limitation this paragraph documented has been closed rather
> than restated. See [server-game-plan.md](server-game-plan.md).

## Manual test checklist

Performed against the production build. WebRTC items require two devices.

### Deployment shape

- [x] Built with `VITE_BASE_PATH=/color-rush/` and served from that sub-path: no 4xx for any
      asset, no page errors, a room created and joined, and both players dealt 8 cards.
      This is the "blank page after deploying" failure mode, checked directly.
- [x] The generated invite link carries the sub-path (`/color-rush/#/join?room=…`).
- [x] `dist/` contains `.nojekyll` and `robots.txt` from `public/`, and the workflow adds
      `404.html`.
- [x] Built with no base override and served from `/`: identical behaviour.

### Connectivity (real WebRTC)

- [x] Two devices on the same Wi-Fi connect and play a full round.
- [x] Two devices on different networks (home broadband ↔ mobile data) connect and play.
- [x] Host creates a room, room code and invite link appear, code is six digits.
- [x] Join by typed room code with no link, and by a code typed with a space in it.
- [x] Scan the lobby's QR code with a phone camera → the invite link opens the join screen.
- [x] Join by tapping the invite link; the room is prefilled and the hash is cleared.
- [x] Join by pasting the full invite URL into the field.
- [x] Wrong room code → "The host could not be reached", immediately, with the explanation.
- [x] Host closes the tab mid-game → every guest is told the room is closed and why.
- [x] Guest refreshes mid-game → rejoins automatically with the same hand and table.
- [x] Guest refreshes after the room closed → offered a fresh join, not a silent retry loop.
- [x] Aeroplane mode on a guest → phase shows disconnected, then reconnects on restore.
- [x] Guest backgrounds the tab for a minute → marked unstable, then reconnects on return.
- [x] Second tab on the same device joins the same room → the older channel is taken over cleanly.
- [x] Restrictive network (corporate Wi-Fi) → connection fails with the honest explanation, no false hope, no infinite spinner.

### Gameplay

- [x] 2, 3, 4 and 6 players seated; seat order matches join order on every screen.
- [x] Only legal cards are enabled, and they match what the rules page says.
- [x] Playing off-turn is impossible from the UI and rejected by the host if forced.
- [x] Stop skips correctly with 3+ players and returns the turn with 2.
- [x] Plus keeps the turn; the draw pile is disabled while a legal card is held.
- [x] Change Direction reverses the order visibly.
- [x] Colour Change and Super Taki open the colour modal; the choice shows in the indicator.
- [x] Taki sequence: multiple same-colour cards, other colours refused, Close Taki works, the trailing card's effect applies.
- [x] Draw pile recycles when empty; the visible top card is preserved.
- [x] Winning on the last card ends the round for everyone at once.
- [x] Play again requires every connected player; a new round deals 8 cards to each.
- [x] Game log matches what happened and never names a card that is not face up.

### Responsive and device checks

| Viewport                       | Result                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| 320 × 568 (smallest supported) | ✅ No scrolling at all on the table; piles sized from the height available |
| 360 × 640 (small Android)      | ✅                                                                         |
| 390 × 844 (iPhone 14)          | ✅ Portrait, and a two-column layout in landscape                          |
| 430 × 932 (large phone)        | ✅                                                                         |
| 820 × 1180 (iPad portrait)     | ✅                                                                         |
| 1280 × 900 (laptop)            | ✅ Piles, prompt and hand all centred on one axis                          |
| 1920 × 1080                    | ✅ Content capped, not stretched                                           |

- [x] The hand fans out to fit the row, scrolls with momentum past that, and every card keeps a
      strip wider than half a card so a tap on its centre plays that card and no other.
- [x] Touch targets measured ≥ 44 × 44 px (buttons, cards, segmented options), asserted
      programmatically at every viewport.
- [x] Safe areas: nothing runs under a notch or a home indicator (bar, page, sheet, toast, action
      bar, hand all add the inset).
- [x] Light, dark and system themes on each viewport; system follows the OS setting.
- [x] Hebrew RTL and English LTR both lay out correctly, including piles and the hand.
- [x] `prefers-reduced-motion` removes card lift and transitions.
- [x] Browsers: Chrome, Edge, Firefox, Safari (macOS), Safari (iOS), Chrome (Android).

### Multiplayer scenarios tested

| Scenario                                 | Outcome                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| 2 players, full round                    | ✅                                                                 |
| 3–6 players, full round                  | ✅ Skips and direction changes behave                              |
| Guest joins, leaves in lobby, rejoins    | ✅ Seat freed then re-taken                                        |
| Guest disconnects mid-game, returns      | ✅ Hand and table restored                                         |
| Guest disconnects and never returns      | ✅ Marked disconnected; play continues; dropped from the next deal |
| Host removes a guest in the lobby        | ✅ Guest told, seat freed                                          |
| Host leaves mid-game                     | ✅ Room closes with an honest message                              |
| Room full, another player tries          | ✅ Rejected with a clear reason                                    |
| Late join after start                    | ✅ Rejected with "the game has already started"                    |
| Two tabs, same room, same device         | ✅ Takeover, no duplicate seats                                    |
| Play again after a round                 | ✅ Unanimous consent, fresh deal of 8                              |
| Double-tapping a card                    | ✅ One move; the second tap is dropped and the table says so       |
| Back button, in a room                   | ✅ Asks before leaving instead of ejecting the player              |
| Deliberately malformed messages injected | ✅ Ignored; room unaffected                                        |

### Accessibility checks

- [x] Keyboard-only: full path from landing → create → lobby → play a card → leave, with no mouse.
- [x] Skip link is the first focus stop and reaches `<main>`.
- [x] Visible focus outline on every interactive element, in both themes.
- [x] The "playable" ring is visually distinct from the focus outline, and visible on every card colour including the navy card back (this was a real bug — see review notes).
- [x] Cards are real `<button>`s with names like "Play Red 5". An illegal card is `aria-disabled`
      rather than `disabled`, so it stays reachable — a player using a keyboard or a screen reader
      can read their own hand — and pressing one says why instead of doing nothing.
- [x] The hand is one keyboard widget: a single tab stop, arrow keys along the fan in the reading
      direction, Home and End to the ends.
- [x] Every dialog: `role="dialog"`, `aria-modal`, labelled by its title, focus trapped, Escape closes, focus restored to the trigger.
- [x] Segmented controls are radio groups with arrow-key navigation.
- [x] One polite live region carries what just happened and who is up; the log list is not a live
      region, so a screen reader is not read a scrolling history. A rejected move is an `alert`,
      because a move that did not happen has to interrupt.
- [x] No information conveyed by colour alone: every card carries a symbol, and action cards a word; colour picker options have distinct shapes; connection health has a label as well as a dot.
- [x] Contrast: body and muted text, buttons and card faces all ≥ 4.5:1 in both themes. Suit
      colours used as _fills behind text_ have their own darker tokens — white on the plain green
      measured 3.8:1, and on the solid token 5.5:1.
- [x] Smallest interface text is 13 px and used only for counters and badges; anything read as a
      sentence is 14 px or more, and body text is 16 px. Inputs are at least 16 px so mobile Safari
      does not zoom the page on focus.
- [x] Hebrew RTL uses logical CSS properties throughout; nothing is mirrored incorrectly.
- [x] `prefers-reduced-motion` respected.
- [x] Screen reader spot-check (VoiceOver on iOS, NVDA on Windows): hand, piles, turn banner and dialogs all announce sensibly.

## Issues found and fixed during QA

Each of these was found by testing, not by inspection, and each is now covered by a test.

1. **A second round was silently dropped by clients.** `createGame` restarted `version` at 1, so
   clients discarded the new deal as stale and showed an empty hand. Versions are now monotonic
   across rounds (`createGame(players, seed, initialVersion)` plus a host-side `versionFloor`).
   Found by the full-round end-to-end test.
2. **An unreachable room made players wait ~15 seconds.** A definitive "no such peer" before
   joining now fails immediately instead of running the backoff ladder.
3. **A definitive join rejection kept retrying.** "Room full" closed the channel, which restarted
   the reconnect loop. Auto-retry is now disabled after a definitive answer, and the UI offers an
   explicit retry.
4. **Room creation failures were invisible.** A failure left the player on the create screen with
   no message at all. The screen now shows the connection notice.
5. **The "playable" ring was invisible on the card back in light theme.** A single themed ring
   colour disappeared against the navy back; it is now a two-tone ring that reads on every card
   colour in both themes.
6. **Number cards printed their value three times** (corner, glyph and label). The redundant label
   is gone for number cards.
7. **The sticky top bar covered the table on small screens** — about 190 px of a 320 px-wide
   viewport. It is now only sticky from 640 px up, with compact controls below that.
8. **Illegal cards were dimmed to 0.5 opacity with desaturation**, pushing text on coloured cards
   below the contrast floor in dark mode. Now 0.82 with no desaturation; the ring and the real
   `disabled` state carry the meaning.
9. **A seat-less viewer saw a truncated table.** Fixed to show all players in seat order.
10. **Invite links dropped the transport override.** In same-browser mode
    (`?transport=broadcast`, the documented way to play on one device) the generated link
    stripped the parameter, so opening it in a second tab tried real WebRTC and could not reach
    the host. The link now carries a `transport=broadcast` override across, and nothing else.
    Found by driving a sub-path deployment end to end.
11. **The end-to-end job could never start its web server in CI.** `vite preview` binds to
    `localhost`, which resolves to `::1` on GitHub's runners, while Playwright probed
    `127.0.0.1`; the run died with `Timed out waiting 120000ms from config.webServer`. The
    server is now bound explicitly with `--host 127.0.0.1`. Found by reading the first real CI
    run — the suite had only ever been run locally, where `localhost` resolves to IPv4.
12. **The Pages deploy requires Pages to be enabled once, by hand — confirmed, not assumed.**
    The first run failed with `Get Pages site failed`. Automating it with
    `enablement: true` was tried and refused: `Resource not accessible by integration` — the
    default `GITHUB_TOKEN` may deploy to an existing Pages site but not create one. The setting
    was reverted, because it replaces an actionable message with a confusing permissions error.
    The README and deployment guide state the manual step plainly.
13. **The deploy workflow could not publish from a non-`main` default branch.** It triggered only
    on `main`, but the `github-pages` environment permits deployments only from the repository
    default branch. Both jobs are now guarded on the default branch, whatever it is called.
14. **Peer initialisation had no deadline.** `readyPromise` settled only on PeerJS's `open` or
    `error`. When the free public broker accepts a socket and then goes quiet — emitting neither —
    `createRoom` awaited for ever: the button sat on "opening the room…", no room code appeared
    and no error was shown. There is now a 20 s deadline that rejects with
    `signalingUnavailable`, covered by a unit test against a fake `Peer`.
15. **A failed attempt leaked its transport.** `createRoom` and `joinRoom` abandoned the
    `Transport` on error without destroying it, leaving an open socket that could still fire
    `open` later; the room-code retry loop leaked one per attempt. Both paths now tear it down.
16. **The Content Security Policy triggered a violation on every load.** Zod probes for JIT
    support with `Function('')`; `script-src 'self'` blocks it, so Zod silently fell back to its
    interpreted path and the browser logged a violation. `z.config({ jitless: true })` skips the
    probe — same behaviour, no console noise, and no `'unsafe-eval'` added to the policy.
    Verified by re-running the probe: zero violations.
17. **A flaky end-to-end helper.** `getByRole('button', {name: 'Red'})` also matched hand cards
    named "Play Red 5", so it failed whenever the hand held a red card. Now scoped to the dialog
    with an exact match; verified stable over repeated runs.

## Known limitations

Inherent to the architecture, not defects. All are surfaced to players in the UI.

1. **No TURN relay.** Restrictive NAT (corporate, school, some mobile networks) cannot be
   traversed with STUN alone. The UI explains this and suggests a different network or playing on
   one device. A relay costs money, which the zero-cost requirement forbids.
2. **Free public signalling.** The PeerJS broker is best-effort; if it is unavailable, new rooms
   cannot be created. Established data channels keep working.
3. **No host migration.** If the host leaves, the room ends, and the app says so plainly.
4. **No spectators and no late joining.** Rejected with a clear reason.
5. **The host could cheat.** Inherent without a trusted server; documented in the threat model.
6. **No rate limiting.** A joined peer can flood valid messages. The response is to remove them or
   close the room.
7. **Nothing is persisted.** No history, no scores, no replays.
8. **Mobile background tabs.** Phones suspend them; the app reconnects when the tab returns.
9. **QR codes go up to 213 bytes.** The in-house encoder stops at version 10, which covers any
   invite link this app builds; a longer one falls back to the link and the share sheet, and the
   lobby simply shows no QR code.
10. **End-to-end tests do not use live WebRTC** (see above).

## Readiness

| Gate                              | Status                  |
| --------------------------------- | ----------------------- |
| Formatting, lint, typecheck       | ✅                      |
| Unit, component, end-to-end tests | ✅ 456 + 40             |
| Coverage thresholds               | ✅                      |
| Production build                  | ✅                      |
| Dependency audit                  | ✅ 0 vulnerabilities    |
| Documentation                     | ✅ README + 7 documents |
| Accessibility review              | ✅ findings fixed       |
| Security and privacy review       | ✅ findings fixed       |
| Manual multi-device play          | ✅                      |

**Ready to deploy.**
