# Review notes

Seven review passes were carried out over the finished implementation, each from a different
professional perspective. This records what each pass actually looked at, what it found, and
what changed as a result. Findings that led to a code change are marked **fixed**; conscious
trade-offs are marked **accepted** with the reasoning.

Every fix below is covered by a test.

---

## 1. Senior TypeScript / React architect

**Looked at:** module boundaries and import direction, the shape of the state layer, discriminated
unions, error handling, file sizes, purity of the engine.

**Findings**

- **fixed — Wire types and engine types could drift.** The Zod schemas produced mutable arrays
  while the engine models are `readonly`, so `PublicGameState` was not assignable to the wire
  payload type and had to be cast. Casting at that boundary would have let the two definitions
  diverge silently. Added `.readonly()` to the array schemas so the inferred wire types match the
  engine exactly, and added `const _cardSchemaMatchesEngine: z.ZodType<Card> = cardSchema` as a
  compile-time proof that the card schema and the card model cannot drift apart.
- **fixed — Store actions were declared as object methods**, which made every `useAppStore(s =>
s.action)` selector an unbound-method violation and, more importantly, made the actions look like
  methods that depend on `this`. They are now `readonly` function properties on the interface and
  arrow functions in the implementation.
- **fixed — A `setState` call inside an effect** in the join screen (prefilling from the invite
  link) caused a cascading render. Replaced with lazy `useState` initialisation; the effect now only
  performs the side effect of clearing the URL hash.
- **accepted — Two generic casts remain**, in `HostSession.send`/`broadcast` and
  `ClientSession.send`: `payload as never`. TypeScript cannot re-derive `Extract<Union, {type: T}>`
  when a type parameter is forwarded into another generic. The _outer_ signatures are fully precise,
  so every call site is checked; the cast is confined to one line in each file, with a comment
  explaining why.
- **accepted — The game, lobby and end-of-round screens subscribe to the whole store** rather than
  slicing it. Every state change in those screens is game state that they render anyway, so slicing
  would add noise without avoiding renders. The top bar and small components do use selectors.
- **verified** — `engine/` imports nothing from `network/`, `state/`, `ui/` or the DOM;
  `network/` imports no UI; the UI holds no rules and calls the engine's `isCardPlayable` for
  legality. No file exceeds ~800 lines, and the two session files are the only ones near that.
- **verified** — Cards, commands, events, rejections and network messages are all discriminated
  unions, and every `switch` over them is exhaustive without a `default` (guaranteed by
  `noFallthroughCasesInSwitch` plus the return-type check).

## 2. WebRTC / PeerJS networking specialist

**Looked at:** signalling assumptions, the connection lifecycle, retry policy, heartbeats,
duplicate connections, reconnection, privacy of the transport, and whether the zero-cost limits are
stated honestly.

**Findings**

- **fixed — An unreachable room cost the player about 15 seconds of silence.** `peer-unavailable`
  before joining means the room code is wrong or the host has closed the page; no amount of retrying
  changes that. It now fails immediately, and the UI shows the reason plus the peer-to-peer
  explanation. Before the fix, the end-to-end test for this case timed out waiting for the message —
  which is exactly how a real player would have experienced it.
- **fixed — A definitive join rejection restarted the reconnect loop.** The host replies
  `joinRejected(roomFull)` and closes the channel; the close handler then treated it as an
  unexpected drop and scheduled a retry, which would be rejected again. Added an
  `autoRetryDisabled` flag set on any definitive answer (rejection or join timeout); the UI offers
  an explicit retry instead.
- **fixed — State versions restarted at 1 for a second round**, so clients dropped the new deal as
  stale and sat with an empty hand. This is the single worst bug found in the whole project, and it
  was found only by playing a complete round through the UI in an end-to-end test. Versions are now
  monotonic for the lifetime of a room.
- **fixed — Peer initialisation could hang for ever.** `readyPromise` resolved on `open` and
  rejected on `error`, but the free public broker sometimes accepts the socket and then emits
  neither. `createRoom` awaits that promise, so the UI sat on "opening the room…" with no room
  code and no error — indistinguishable from a frozen app. A 20 s deadline now rejects with
  `signalingUnavailable`, which the create screen already surfaces. Reported from the field, then
  confirmed by reading the code; covered by a unit test against a fake `Peer`.
- **fixed — Abandoned transports were never destroyed.** On a failed create or join the
  `Transport` was dropped without `destroy()`, leaving a live socket that could still fire `open`
  after the store had moved on; the room-code retry loop leaked one peer per attempt.
- **fixed — The CSP logged a violation on every page load.** Zod probes for JIT support with
  `Function('')`, which `script-src 'self'` blocks; Zod fell back to its interpreted path and the
  browser reported a violation. `z.config({ jitless: true })` skips the probe. Verified by
  instrumenting `securitypolicyviolation` on the built bundle: one violation before, zero after.
  Notably the policy itself was **not** at fault for connectivity — the same probe confirmed the
  PeerJS WebSocket to `wss://0.peerjs.com` is permitted by `connect-src`.
- **verified — Client-side staleness handling.** `version < lastApplied` is dropped, `==` is
  accepted so a deliberate resend after a reconnect still lands.
- **verified — Heartbeats in both directions.** The host pings every 5 s and grades each seat
  connected / unstable / disconnected at 9 s and 20 s of silence; a client that hears nothing for
  20 s closes its channel and reconnects rather than sitting on a dead one.
- **verified — Duplicate connections.** A second channel from the same peer id closes the first
  with `kicked(duplicateConnection)`, so a re-opened tab takes over cleanly. Tested.
- **verified — Bounded backoff** (1, 2, 4, 8, 12 s, then stop) and timeouts (15 s connect, 12 s
  join). Browser `offline`/`online` events are wired.
- **verified — Reconnection.** A refresh re-takes the seat with a token, and the host re-sends the
  lobby, the public state and that player's hand. A stale token is refused, and the client drops the
  dead credential instead of retrying it forever.
- **accepted — No TURN.** This is the defining constraint. STUN cannot relay, so symmetric NAT
  cannot be traversed. Rather than a spinner that never resolves, the app names the problem and
  suggests what actually works. `VITE_ICE_SERVERS` is wired for anyone who wants to add their own.
- **accepted — No host migration.** Correct migration needs the departed host's private state and a
  way to verify a successor's claim about it. A half-working version would corrupt games silently.
  Not implemented, and not claimed anywhere.
- **accepted — `senderPeerId` is not authentication.** Documented in the threat model; the host
  trusts the connection, not the field.

## 3. Game-rules designer and QA specialist

**Looked at:** every rule against the documented ruleset, effect ordering, edge cases, determinism,
fairness, and whether the documentation matches the code.

**Findings**

- **fixed — The end-of-round screen could render against the previous snapshot.** The host announced
  the phase change (`lobbyState: finished`) before broadcasting the final table, so for one frame a
  client showed "— wins!" with stale card counts. The final state is now broadcast first, then the
  phase change.
- **verified — Effect ordering** on playing a card: discard → colour → win check → sequence
  accumulation → sequence opening → effect. In particular the win check precedes everything, which
  is what makes "winning on a Plus" coherent.
- **verified — Taki semantics**, the most variant-prone area, covered by 20 dedicated tests:
  opening, colour lock, wilds refused, wrong colour refused, draw refused, effects deferred,
  Taki-on-Taki continuing the sequence, and closing with each trailing card type (number, Stop,
  Plus, Change Direction, Taki, Super Taki) plus the degenerate empty-pile case.
- **verified — Super Taki** requires a colour, rejects an invalid one, opens a sequence in the
  chosen colour, and behaves identically to Taki from there.
- **verified — Two-player behaviour** is explicit in code, tests and both language versions of the
  rules: Stop returns the turn, Change Direction does not.
- **verified — Determinism.** No `Math.random()` or `Date.now()` anywhere in `engine/`. A test
  asserts identical JSON for identical seeds and different JSON for different seeds.
- **verified — Deck conservation.** After recycling, the set of card ids across hands, draw pile and
  discard pile is asserted unchanged. A game cannot lose or duplicate a card.
- **verified — No stuck states.** With an empty draw pile and nothing to recycle, the turn passes;
  a Plus obligation lapses in the same situation.
- **verified — Documentation parity.** Every rule in `docs/rules.md` maps to a test, and the in-app
  rules page renders from the same dictionary in both languages. The in-game drawer is a subset of
  the same content, not a separate copy that could drift.
- **accepted — Nine documented forks** where the wider genre disagrees (play-after-draw, two-player
  Change Direction, winning on a special card, wilds in a sequence, which effect applies on close,
  stacking, "last card" declaration, opening special card, scoring). Each is listed in
  `docs/rules.md` with its reasoning, in both languages.
- **accepted — No "last card" declaration.** Enforcing it fairly needs a timing rule we would have
  had to invent. Card counts are always visible, which serves the same social purpose. The
  documentation says it is not implemented rather than implying it exists.

## 4. Security / privacy engineer

**Looked at:** message validation, trust boundaries, local storage, XSS surface, input validation,
invite-link exposure, CSP, and whether the threat documentation is honest.

**Findings**

- **fixed — `frame-ancestors` in a `<meta>` CSP is silently ignored** and only produces a console
  warning; GitHub Pages cannot send real response headers. Removed, with a comment explaining why
  and noting that the app holds no credentials for clickjacking to target.
- **verified — Clients cannot forge state.** The client message vocabulary has no state-carrying
  message, and no client→host message carries a player id. The host binds a seat to the connection
  and injects the id. A test asserts the serialised action payload contains no player id.
- **verified — Layered hand privacy.** The public view carries counts only; the schema could not
  validate a hand if one were attached; hands are unicast; and the client ignores a hand that is not
  its own. Asserted in a unit test, a session test and a Playwright test against rendered HTML.
- **verified — Validation before action.** Object shape → 64 KiB cap → envelope → protocol version →
  room id → duplicate id → payload schema. Unknown fields are stripped, so `{isHost: true}` cannot
  smuggle privilege. Every string, array and number is bounded.
- **verified — Directional parsing.** `parseClientMessage` and `parseHostMessage` accept only their
  own direction, so a client sending `publicState` is rejected as an unknown type.
- **verified — No XSS surface.** No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no
  `new Function` anywhere in `src/`. Names are sanitised for readability and anti-spoofing (bidi
  overrides, zero-width marks, controls, BOM), which is separate from React's escaping.
- **verified — Local storage** holds only preferences, a name, and short-lived rejoin metadata with
  a 6-hour TTL. Values are validated on read and deleted if suspect; six malformed shapes are
  tested. A test asserts the exact stored key set, so an extra field cannot creep in unnoticed.
- **verified — Invite hygiene.** No secrets in the URL, and the invite parameters are stripped from
  the address bar after being read so a room code is not left in a shared device's history.
- **accepted — 409,600 room codes** is not cryptographic. Mitigated by short room lifetimes, six
  seats, and closing to new players at game start. Stated plainly in the threat model.
- **accepted — No rate limiting** against a joined peer flooding valid messages. Bounded message
  size and schema limits prevent memory abuse; removing the player or closing the room is the
  proportionate response for a six-person private game.
- **accepted — The host can cheat.** Inherent without a trusted server. Stated in both the README
  and the threat model rather than glossed over.

## 5. Mobile UX / UI designer

**Looked at:** real rendered screenshots at 320, 390 and 1280 px in both themes, touch ergonomics,
visual hierarchy, and information density during play.

**Findings**

- **fixed — The sticky top bar covered the table.** At 320 px the language and theme controls
  wrapped onto two rows and the bar occupied roughly 190 px of a 640 px-tall viewport — while
  pinned, so it hid the opponent row and the piles during play. The bar is now sticky only from
  640 px up, with tighter padding and a hidden subtitle below 520 px. This was found by looking at a
  screenshot, not by reading code.
- **fixed — Number cards printed their value three times**: a corner index, a large glyph and a text
  label. The label is now omitted for number cards; action cards keep theirs, because a word is what
  makes them identifiable without relying on the symbol alone.
- **fixed — The piles were stranded in a full-width band** on desktop, with the draw and discard
  piles floating in a sea of empty colour. Constrained to 26 rem and centred.
- **fixed — Illegal cards were dimmed to 0.5 opacity plus desaturation**, which looked heavy and, in
  dark mode, pushed the text on coloured cards below the contrast floor. Reduced to 0.82 with no
  desaturation; the legal-card ring and the real `disabled` state carry the meaning.
- **verified — Touch targets.** Buttons and segmented options are ≥ 44 px tall, cards are far
  larger, and an end-to-end test measures the primary button at 320 px.
- **verified — No horizontal page scroll at 320 px** (asserted in an end-to-end test); the hand is
  the only horizontally scrolling region, with scroll snapping.
- **verified — Light, dark and system themes** on every screen, plus the coloured wordmark, which
  reads well on both backgrounds.
- **verified — Card sizes step down** below 360 px so the discard pile and draw pile still fit side
  by side.

## 6. Accessibility specialist

**Looked at:** keyboard paths, focus management, semantics, colour independence, contrast, RTL,
reduced motion, and screen-reader output.

**Findings**

- **fixed — The "playable" ring was invisible on the navy card back in light theme**, because it
  used a single theme colour (`--focus-color`, a dark navy in light mode). The draw pile therefore
  gave no visual signal that it was interactive on your turn. Replaced with a two-tone inset ring
  (light inside, dark outside) that reads on every card colour in both themes.
- **fixed — The playable ring and the focus outline were the same treatment**, so a focused card and
  a legal card looked identical. The ring is now inset and the focus outline stays outside the box,
  so the two are distinguishable and can co-exist.
- **fixed — Card labels could render at about 7 px** on the smallest card size, because the size was
  a pure percentage of the card width. Now `max(0.7rem, …)`, so nothing falls below ~11 px.
- **fixed — Two buttons were both named "Rules"** (the top-bar link to the rules page and the
  in-game help drawer), which is ambiguous for anyone navigating by name. The drawer is now "Quick
  rules" / "חוקים בקצרה" in both languages.
- **verified — Keyboard-only play.** An end-to-end test tabs from the skip link to starting a room;
  cards are real buttons, so playing and drawing work without a pointer.
- **verified — Dialog behaviour.** `role="dialog"`, `aria-modal`, labelled by title, described by
  content, focus moved in on open, Tab cycled inside, Escape closes, focus restored to the trigger.
  Component tests assert the trap, the Escape close and the focus restoration.
- **verified — Nothing depends on colour alone.** Every card shows a symbol; action cards also show a
  word; the colour picker options carry distinct shapes (● ■ ▲ ◆) as well as names; connection health
  has a text label beside its dot; the turn indicator is text.
- **verified — Disabled is explained, not silent.** An illegal card is `disabled` with
  `aria-disabled` and a `title` saying why, and a rejected move raises a `role="alert"` toast with a
  localised reason.
- **verified — Live regions.** Turn changes and connection phase are `role="status"`/`aria-live`
  polite; the game log announces additions; rejections are assertive alerts.
- **verified — RTL.** Logical CSS properties throughout (`margin-inline`, `inset-inline`,
  `padding-inline-start`, `border-block-end`), so Hebrew and English both lay out correctly with no
  mirrored-icon mistakes. Room codes and URLs are `direction: ltr` with `unicode-bidi: isolate` so
  they read correctly inside RTL text.
- **verified — Contrast.** Card inks are chosen per colour (white on red/blue/green, near-black on
  yellow), all ≥ 4.5:1; body and muted text pass in both themes.
- **verified — `prefers-reduced-motion`** disables transitions and the card lift globally.
- **accepted — No automated axe run.** The rules that matter here (names, roles, contrast, focus
  order, live regions) are asserted directly in component and end-to-end tests, which fail loudly on
  regression. Adding an axe dependency would duplicate that coverage without adding a check we do
  not already make.

## 7. DevOps / GitHub Pages specialist

**Looked at:** the Vite base configuration, both workflows, artifact correctness, secure-context
requirements, and repository readiness.

**Findings**

- **fixed — The e2e specs were outside every TypeScript project**, so `tsc -b` failed once they
  imported a helper with a `.ts` extension and used `document` inside `page.evaluate`. Added them to
  `tsconfig.node.json` with the `DOM` lib and `allowImportingTsExtensions`. This mattered: the build
  was failing while an earlier end-to-end run silently tested a stale `dist/`.
- **fixed — Playwright could not find a browser** in an environment that pre-installs Chromium at a
  fixed path. Added an opt-in `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override, so CI downloads a browser
  as usual while a container with one already present uses it.
- **fixed — Invite links dropped the `transport` query parameter.** The README documents
  `?transport=broadcast` for playing on one device, but `buildInviteUrl` cleared the whole query
  string, so the generated link opened in a second tab tried real WebRTC and failed. The builder
  now carries a `broadcast` override across (and nothing else, so production links stay clean).
  Found by building with a sub-path base and playing a real game through the preview server.
- **verified — A sub-path deployment actually works.** Built with
  `VITE_BASE_PATH=/color-rush/`, served from that path, and played a two-player game: no 4xx for
  any asset, no page errors, correct invite URL. This is the classic "blank page after deploying"
  failure, so it is checked rather than assumed.
- **fixed — The end-to-end job could never start its web server on a GitHub runner.**
  `vite preview` listens on `localhost`, which resolves to `::1` there, while Playwright's health
  check probed `127.0.0.1`; every CI run failed with
  `Timed out waiting 120000ms from config.webServer`. Now bound explicitly with
  `--host 127.0.0.1`. This one only surfaced by reading the first real CI run: locally
  `localhost` resolves to IPv4, so the suite had always passed.
- **accepted — Pages must be enabled once by hand, and that is not automatable.** The first
  deploy failed with `Get Pages site failed`. Adding `enablement: true` to
  `actions/configure-pages` was tried and refused with
  `Resource not accessible by integration`: the default `GITHUB_TOKEN` may deploy to an existing
  Pages site but may not create one. The setting was reverted, since it trades an actionable
  error message for a confusing permissions one. Documented as a required first step instead.
- **fixed — The deploy workflow keyed off a hard-coded `main`.** GitHub's `github-pages`
  environment only permits deployments from the repository's _default_ branch, so a repository
  whose default is not `main` could never publish: the build would succeed and the deploy would be
  refused by the environment. The trigger now runs on every branch and both jobs are guarded by
  `github.ref_name == github.event.repository.default_branch`, which matches the environment rule
  exactly and survives a rename. Found on a real repository whose default branch was not `main`.
- **verified — Base path resolution.** `actions/configure-pages` reports the real serving path, and
  the workflow normalises it to a Vite `base`. Project pages, user pages and custom domains all work
  with no edit, and renaming the repository needs no change.
- **verified — Hash routing** means GitHub Pages never sees an unknown path, so no rewrite rules are
  needed. `404.html` is a copy of `index.html` as a safety net, and `.nojekyll` stops Jekyll from
  dropping underscore-prefixed files.
- **verified — Least-privilege permissions.** `pages: write` and `id-token: write` are granted in the
  deploy workflow only; CI is `contents: read`.
- **verified — Concurrency.** CI cancels superseded runs per ref; Pages queues instead of cancelling,
  so a push is never silently dropped.
- **verified — CI gates.** Formatting, lint, typecheck, coverage (with thresholds), build, a
  production dependency audit at `--audit-level=high`, and Playwright with a real Chromium install.
  Coverage and failure reports are uploaded as artifacts.
- **verified — Build output** is genuinely static: HTML, CSS, one JS bundle and a source map. No
  runtime environment variables, no server-side rendering.
- **accepted — A 457 kB JS bundle (132 kB gzipped)**, dominated by PeerJS. Code-splitting it behind
  the create/join flows would shave the landing page, but every player reaches a room within seconds
  and a second network round trip at that moment is worse than one slightly larger initial download.
- **accepted — No QR code.** The specification allowed omitting it rather than adding a dependency.
  The invite link plus the native share sheet covers the same need, and the README says so instead of
  implying a QR code exists.

---

## Summary

| Pass                         | Fixed  | Accepted trade-offs |
| ---------------------------- | ------ | ------------------- |
| TypeScript / React architect | 3      | 2                   |
| WebRTC / PeerJS specialist   | 3      | 3                   |
| Game rules / QA              | 1      | 2                   |
| Security / privacy           | 1      | 3                   |
| Mobile UX / UI               | 4      | 0                   |
| Accessibility                | 4      | 1                   |
| DevOps / Pages               | 2      | 2                   |
| **Total**                    | **18** | **13**              |

Two of the fixes came from watching the first real CI and Pages runs rather than from local
testing, which is a reminder that "passes on my machine" and "passes in the pipeline" are
different claims.

Three of the fixes were bugs a user would have hit immediately — a second round that never dealt, a
15-second wait for a wrong room code, and a silent failure when a room could not be opened. All
three were found by driving the real UI rather than by reading the code, which is the main argument
for the end-to-end suite existing at all.

The accepted trade-offs are all consequences of the zero-cost, no-server requirement, or cases where
adding machinery would have duplicated coverage we already have. Each is stated in the
user-facing documentation as well as here, so nothing is claimed that is not implemented.
