# Look and feel — plan of record

Goal: **the table should be felt, not only read.** Today a move changes a number, a colour and
a truncated line of text. Every fact is available and none of it arrives as a sensation. This
plan adds motion, depth and sound to the table without touching a rule, a wire format or the
engine.

Twenty-nine tasks, in five waves. Every task names the file it edits, what "done" means, and
the test that proves it. Constraints kept: static site on GitHub Pages, zero third-party cost,
no external asset of any kind, `engine/` stays pure, RTL and LTR identical, both themes,
`prefers-reduced-motion` honoured, and excellent on a 320 px phone.

---

## Table of contents

- [Budget and baseline](#budget-and-baseline)
- [What the investigation found](#what-the-investigation-found)
- [The substrate](#the-substrate)
- [Deliberate deviations from the review](#deliberate-deviations-from-the-review)
- [Wave 0 — substrate](#wave-0--substrate)
- [Wave 1 — repairs to motion that already exists](#wave-1--repairs-to-motion-that-already-exists)
- [Wave 2 — cheap new cues](#wave-2--cheap-new-cues)
- [Wave 3 — the hand](#wave-3--the-hand)
- [Wave 4 — flight](#wave-4--flight)
- [Wave 5 — sound and haptics](#wave-5--sound-and-haptics)
- [Test strategy](#test-strategy)
- [Exit criteria](#exit-criteria)

---

## Budget and baseline

Measured on this branch before any change:

| Artefact | Raw | Gzip |
| -------- | --------- | ---------- |
| JS | 551.05 kB | 160.63 kB |
| CSS | 36.69 kB | 8.04 kB |
| Tests | 678 in 38 files | — |

**Ceiling for the whole programme: +12 kB raw JS, +4 kB raw CSS, +5 kB gzip total.** No
animation library, no audio file, no font, no image. If a task cannot fit, it is cut rather
than allowed to grow the bundle past this.

---

## What the investigation found

Six things that changed the shape of this plan, all verified in the source rather than assumed:

1. **The best cue in the game is already written and unreachable.** `cards.css:266` raises a
   playable card by 10 px — on `:hover` and `:focus-visible` only. A phone fires neither, and
   iOS Safari makes `:hover` *stick* after a tap, so the one place it does fire on touch leaves
   a card stranded in the air. The task is to drive it from state, not to invent it.
2. **The event vocabulary is far richer than anything consuming it.** `GameEvent` has 22
   members, already broadcast to every client, carrying exactly the fields motion needs —
   `drawStacked.total`, `plusThreeBroken.targetId`, `lastCardCaught.caughtById`,
   `takiClosed.cardsPlayed`. All of it renders as one truncated line in a ticker.
3. **Two surfaces already animate, and must not be rebuilt.** `.discard` cross-fades its colour
   rail over 240 ms (`cards.css:416`) and `.seat` cross-fades border and background over 240 ms
   (`screens.css:437`). Change Colour is currently the best-animated moment in the app.
4. **The turn banner changes `font-size`** between states (`screens.css:593`, `:605`) with no
   transition — a layout property, on the most frequent state change in the game.
5. **The stylesheet contradicts itself.** `declare-pulse` is `infinite` at `screens.css:546`
   and `animation: none` at `:852`. Two opinions about the same animation, 300 lines apart.
6. **`--dur-slow: 380ms` is declared and never used.** Four speeds advertised, three spent.

And one constraint that shapes every task below: **jsdom implements no Web Animations API.**
`element.animate` is `undefined` under test, and `matchMedia` is stubbed to `matches: false`.
Every motion path must feature-detect and degrade to an instant, correct DOM.

---

## The substrate

Three new modules. Everything else in the plan is a caller of these.

### `beat` — one presentation signal per move

The animation layer needs three things in one place: what the table was, what it is, and which
events caused the change. Today those arrive as three separate store writes and no consumer can
see all three at once.

`store.ts` gains a `beat` field, published when the `events` update arrives — which is last on
the wire, because `hostSession.broadcastGameState()` runs before `emitEvents()` over one ordered
data channel:

```ts
export interface Beat {
  readonly seq: number;                 // monotonic, minted like feedCounter
  readonly events: readonly GameEvent[];
  readonly from: TableSignature | null; // the table before this move
  readonly to: TableSignature;          // the table after it
  readonly origin: 'local' | 'remote';
}

interface TableSignature {
  readonly version: number;
  readonly discardTopId: string | null;
  readonly drawPileCount: number;
  readonly activeColor: CardColor;
  readonly direction: 1 | -1;
  readonly currentPlayerId: string | null;
  readonly handIds: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}
```

`from` is captured in the `publicState` case, before the new state overwrites the old. `origin`
is derived from the request the store already tracks: `submit()` mints `pendingRequestId`, so
stashing the intended `cardId` beside it is enough to recognise our own move coming back.

**The invariant that makes all of this safe: the real DOM is always the authoritative
post-state, and motion is a lie told on top of it by a layer that owns nothing.** A snapshot
arriving mid-flight never has to roll anything back, because nothing in flight is load-bearing.

### `choreograph.ts` — a pure planner

`(beat, options) => readonly Motion[]`. No DOM, no refs, no React — the same shape as
`handLayout.ts` and `eventText.ts`, so "does a +3 broken by a breaker produce the right two
flights" is a vitest assertion rather than something verified by playing.

```ts
type Motion =
  | { kind: 'flight'; key: string; from: AnchorId; to: AnchorId; card: Card | null;
      faceDown: boolean; delayMs: number; durationMs: number }
  | { kind: 'pulse'; key: string; at: AnchorId; tone: 'danger' | 'success' | 'neutral';
      delayMs: number; durationMs: number }
  | { kind: 'sweep'; key: string; direction: 1 | -1; durationMs: number };
```

Interruption rules live here, not in the view:

- **Never block, never roll back.** Input is never gated on motion.
- **Backlog cap of 2.** If `beat.seq` runs more than 2 ahead of what is on screen, cancel
  everything in flight and play only the newest beat. A six-card Taki run must not become a
  1.4-second cutscene: fly its first and last card and skip the middle.
- **Keyed and idempotent.** `key = ${seq}:${kind}:${cardId}`, so a replayed beat after a
  reconnect produces the same keys and is dropped rather than animated twice.
- **Reduced motion is decided here**, in JS, via `matchMedia`. It returns opacity-only
  substitutes rather than an empty list, because the comprehension the motion buys must survive.

### `motion.ts` — the one place that touches the platform

A thin helper wrapping WAAPI so that no other file has to feature-detect:

```ts
export function animate(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null;
export function prefersReducedMotion(): boolean;
export function cancelAll(animations: Iterable<Animation | null>): void;
```

`animate` returns `null` when `element.animate` is absent (jsdom, and any browser that
surprises us), and every caller must treat `null` as "the DOM is already correct, do nothing".
This is what keeps the existing 678 tests green.

**Web Animations API, not a library.** framer-motion is ~35 kB gzip, motion-one ~5 kB. We need
three cubic-bezier curves and `element.animate`, which ships in every browser in our matrix and
costs zero bytes.

---

## Deliberate deviations from the review

Two places where this plan does not do what the review asked, with the reasoning. Both are
flagged for the plan reviewer to attack.

**1. The beat is a derived signal, not a coalescing buffer.** The review asked for the three
updates to be buffered and flushed on a microtask, to collapse three React commits into one. I
am not doing that, for two reasons. First, it does not work as described: the three messages
arrive in three separate *macrotasks*, and a microtask flush only coalesces writes made within
one task — so the commits would still be three. Genuinely collapsing them needs correlation by
`version` plus a timer for the message that may never come (`emitEvents` returns early on an
empty batch, and `privateHand` goes only to seated players), which adds latency to state
application on the critical path of every move. Second, the payoff is smaller than claimed:
card faces are memoised on card identity, so a `publicState` commit does not rebuild glyph
geometry, and three cheap commits microseconds apart land in the same frame. The *information*
problem the review correctly identified — no single place sees `from`, `to` and `events`
together — is solved by the derived beat at zero latency and zero risk to 678 tests. If a
measurement later shows real dropped frames, coalescing can be added behind the same `beat`
interface without touching a single consumer.

**2. `.seat` and `.discard` keep their existing colour transitions.** The review described the
seat's turn state as "a static tint that is either on or off". It is not; both surfaces already
cross-fade over 240 ms. Those tasks are therefore narrowed to adding transform and bloom, and
the Change Colour moment is left alone entirely.

---

## Wave 0 — substrate

Nothing visible ships in this wave. It exists so that the twenty-six tasks after it are small.

### T1 — `beat` in the store

- **Files:** `src/features/game/state/store.ts`, `src/features/game/state/selectors.ts`
- **Change:** add `Beat`/`TableSignature`, capture `from` in the `publicState` case, publish
  `beat` in the `events` case, tag `origin` from `pendingRequestId`. Clear `beat` wherever
  `feed` is already cleared (three sites: new round, resume, leave).
- **Acceptance:** one beat per accepted command; `seq` strictly increasing; `from` is `null`
  only for the first beat of a round; `origin` is `local` exactly when the batch contains a
  `cardPlayed`/`cardDrawn` for `localPlayerId` that matches the outstanding request.
- **Tests:** `tests/unit/state/beat.test.ts` — new. Drive the store through a memory-transport
  session and assert the sequence, the signatures, `origin` for both a local and a remote move,
  and that a duplicate event batch (host replay) does not mint a second beat.

### T4 — `choreograph.ts` and the interruption rules

- **Files:** `src/features/game/ui/choreograph.ts` — new
- **Change:** the pure planner and `Motion` union above, covering every event this plan
  animates. Backlog cap, run compression, keying, reduced-motion substitution.
- **Acceptance:** pure — no import from `react`, no DOM reference. A six-card Taki run yields
  two flights, not six. A beat replayed yields identical keys.
- **Tests:** `tests/unit/ui/choreograph.test.ts` — new, table-driven over every animated event
  type, plus the three interruption rules and the reduced-motion path.

### T7 — reduced motion decided in JS

- **Files:** `src/lib/motion.ts` — new; `src/styles/base.css`
- **Change:** `prefersReducedMotion()` reading `matchMedia`, and the `animate` wrapper.
  Narrow the blanket `!important` kill in `base.css:261` so that it no longer silently
  annihilates opacity substitutes — keep killing transforms and long animations, allow a short
  opacity fade.
- **Acceptance:** with reduced motion on, every state change still produces a visible cue
  (currently it produces none: the blanket rule kills both `land` and the discard cross-fade,
  leaving only a ticker that swaps silently). With it off, nothing changes.
- **Tests:** `tests/unit/lib/motion.test.ts` — new. `animate` returns `null` without WAAPI;
  `prefersReducedMotion` reads the query; a stubbed `matches: true` produces opacity-only plans
  from `choreograph`.

---

## Wave 1 — repairs to motion that already exists

Six tasks, no new subsystem, no new bytes of consequence. This is the cheapest feel improvement
in the plan and it ships first.

### T2 — the playable lift, driven by state

- **Files:** `src/styles/cards.css`, `src/features/game/ui/components/TableParts.tsx`
- **Change:** wrap the existing `:hover` rule at `cards.css:266` in `@media (hover: hover)` so
  touch can never get stuck-hover. Add `.hand--my-turn .card--playable` carrying the same
  `translateY(-10px)`, with a `--lift-delay` per slot for a 25 ms stagger, transitioned over
  260 ms.
- **Acceptance:** on my turn, playable cards rise once, in sequence, and stay up; unplayable
  cards do not move; on a touch device no card is ever left raised after a tap; keyboard focus
  still lifts a card on desktop.
- **Tests:** `tests/component/table.test.tsx` — assert the class is present on my turn and
  absent otherwise. Playwright `tableLayout.spec.ts` — assert no card is raised after a tap on
  a touch context.

### T6 — the turn banner stops jumping

- **Files:** `src/styles/screens.css`
- **Change:** `.turn-banner--mine` no longer changes `font-size`. One size for both states;
  emphasis moves to `scale(1.04)` plus the existing colour change, and the element gains a
  transform/colour transition.
- **Acceptance:** becoming the current player no longer reflows the turn row; the banner is
  still visibly more prominent on my turn; the row's height is identical in both states at
  320 px.
- **Tests:** Playwright — measure `.turn-row` height in both states and assert equality.

### T18 — one opinion about `declare-pulse`

- **Files:** `src/styles/screens.css`
- **Change:** `animation-iteration-count: 3` instead of `infinite`, in one place. Delete the
  contradicting `animation: none` override at `:852`.
- **Acceptance:** the declare button pulses three times and rests, at every viewport size.
  The health dot's pulse becomes the only infinite animation in the app, reserved for
  connection trouble.
- **Tests:** unit assertion on the compiled stylesheet is not worth it; covered by a Playwright
  screenshot-free assertion that `animation-iteration-count` is `3` in both orientations.

### T14 — the playable ring stops repainting the card

- **Files:** `src/styles/cards.css`
- **Change:** remove `box-shadow` from the `button.card` transition list at `:220`. Draw the
  playable ring on an `::after` pseudo-element and transition its **opacity** instead.
- **Acceptance:** the ring is visually identical in both themes; a turn change no longer
  transitions `box-shadow` on up to eight cards at once, each of which contains five extruded
  SVG glyph groups.
- **Tests:** Playwright visual assertion that the ring's geometry is unchanged; component test
  that `card--playable` still marks the same cards.

### T26 — softer hand scale steps

- **Files:** `src/features/game/ui/handLayout.ts`
- **Change:** `handCardScale` from two steps to four, so the largest single jump is ~7 % rather
  than 14 %.
- **Acceptance:** existing layout tests still pass at every count; no card is smaller than the
  current minimum at any count.
- **Tests:** `tests/unit/ui/handLayout.test.ts` — extend the existing table with the new
  thresholds and assert monotonic non-increasing scale.

### T29 — `--dur-slow` earns its place or leaves

- **Files:** `src/styles/tokens.css`, wherever T9/T17/T28 land
- **Change:** the flight, win-hold and recycle work is what 380 ms was reserved for. Adopt it
  there; if any of those are cut, delete the token.
- **Acceptance:** no declared motion token is unused at the end of the programme.
- **Tests:** a grep assertion in the existing i18n-style consistency test.

---

## Wave 2 — cheap new cues

Seven tasks. Each is small, each is independent of the flight layer, and each survives on its
own if Wave 4 is cut.

### T5 — turn-enter cue

- **Files:** `src/features/game/ui/screens/GameScreen.tsx`, `src/styles/screens.css`
- **Change:** key the banner on `currentPlayerId` so it re-enters — `scale(.96)→1`, opacity,
  `translateY(4px)→0`, 300 ms `--ease-out`. A 220 ms ring bloom on the incoming seat, once, via
  `motion.animate`. The seat's existing colour cross-fade is untouched.
- **Acceptance:** every turn change produces one visible transition on the banner and one on
  the incoming seat; no loop; nothing on the outgoing seat.
- **Tests:** component — the banner's `key` changes with `currentPlayerId`. Unit — the planner
  emits exactly one `pulse` for a `turnChanged` beat.

### T8 — the ticker announces itself

- **Files:** `src/features/game/ui/components/GameLog.tsx`, `src/styles/screens.css`
- **Change:** a 150 ms background flash on the ticker **pill**, keyed on the newest entry's id.
  The text is not animated — it is the comprehension fallback and the semantic neighbour of the
  live region.
- **Acceptance:** a new line flashes once; an unchanged feed does not; reduced motion still gets
  the flash, because it is opacity and colour only.
- **Tests:** component — the pill's animation key advances with a new entry and not otherwise.

### T11 — a blocked draw pile explains itself

- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/styles/cards.css`
- **Change:** replace the real `disabled` attribute at `TableParts.tsx:208` with
  `aria-disabled` plus a click handler that surfaces `drawBlockedReason`, matching the pattern
  cards already use through `onRefuse`. A disabled button gets no `:active`, no press feedback,
  and its `title` is unreachable on most browsers — so today the tap is a silent dead end while
  an illegal *card* tap explains itself.
- **Acceptance:** tapping a blocked pile shows the same style of refusal a blocked card does;
  the pile is still not focusable-as-actionable for a screen reader when it cannot be used;
  `canDraw` behaviour is otherwise unchanged.
- **Tests:** component — tap a blocked pile, assert the refusal text appears and no `drawCard`
  intent is submitted.

### T12 — the false landing cue

- **Files:** `src/features/game/ui/components/TableParts.tsx`
- **Change:** `card--landing` is applied to a `CardFace` keyed on `discardTop.id`
  (`TableParts.tsx:221`), so the CSS animation replays on **any** remount — a reconnecting
  client watches a card land that nobody played. Drive it from `beat` instead: the class is
  applied only when the newest beat contains a `cardPlayed`.
- **Acceptance:** a fresh mount with an existing discard does not animate; a played card does.
- **Tests:** component — render with a discard top and no beat, assert no landing class; then
  deliver a beat containing `cardPlayed` and assert it.

### T19 — the draw pile has thickness

- **Files:** `src/styles/cards.css`, `src/features/game/ui/components/TableParts.tsx`
- **Change:** two stacked backs via `::before`/`::after`, offset from a `--depth` custom
  property bucketed from `drawPileCount` (>30, >15, >5, ≤5 → 3 px, 2 px, 1 px, 0). A 160 ms
  lift-and-settle on tap, replacing the generic `scale(0.96)` for this one control.
- **Acceptance:** the deck visibly thins as the round runs; tapping feels like pulling a card
  off rather than pressing a button; the count text is unchanged.
- **Tests:** component — assert the depth bucket for representative counts.

### T22 — direction reversal is spatial

- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/styles/screens.css`
- **Change:** on a `directionChanged` beat, sweep a 12 px translucent band across
  `.seats__list` in the new direction over 280 ms, and rotate the direction chip 180°. Note
  `components.css:242` already declares `transition: rotate` on an element that is not the
  chip — the intent exists and is unwired.
- **Acceptance:** a Change Direction card produces one sweep in the correct direction in both
  RTL and LTR; nothing sweeps on any other event.
- **Tests:** unit — the planner emits a `sweep` with the right sign for `directionChanged`.

### T23 — a penalty that lands on me

- **Files:** `src/features/game/ui/screens/GameScreen.tsx`, `src/styles/screens.css`
- **Change:** one 120 ms `--danger-soft` flash behind the hand area when a beat's penalty
  targets `localPlayerId`. Once. Not a shake.
- **Acceptance:** fires for a penalty aimed at me and never for one aimed at somebody else.
- **Tests:** unit — planner emits a `pulse` at the `hand` anchor only when the target is me.

---

## Wave 3 — the hand

### T3 — FLIP the hand

- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/styles/cards.css`
- **Change:** capture every `.hand__slot` rect keyed by card id before the beat commits; after
  commit, animate each surviving slot from its old position with a 220 ms transform. New cards
  fade in place (Wave 4 gives them a flight). Removed cards need nothing.
- **Two non-negotiables**, both about the target hardware: animate the **`.hand__slot`** (a
  bare div), never the `.card` — the card carries a four-layer shadow and five extruded SVG
  glyph groups, and transforming it forces those into their own composited layers. And drop
  `will-change` in the animation's `finish` handler; fourteen permanently promoted layers is how
  a 60 fps budget is lost.
- **Acceptance:** paying a four-card penalty reflows the hand as motion rather than a teleport;
  no layout property is animated; the solved layout is byte-identical to today's at rest.
- **Tests:** component — with WAAPI absent (jsdom) the hand renders identically to today, which
  is the regression that matters. Unit — the FLIP delta calculation is extracted as a pure
  function and tested directly.

---

## Wave 4 — flight

Seven tasks. This is the one wave that adds a subsystem, and the only one carrying real risk of
feeling wrong. It is last for that reason, and everything before it stands without it.

### T9 — the flight overlay

- **Files:** `src/features/game/ui/components/FlightLayer.tsx` — new; `src/features/game/ui/anchors.ts`
  — new; `src/styles/cards.css`; `src/features/game/ui/screens/GameScreen.tsx`
- **Change:** a `position:absolute; inset:0; pointer-events:none` layer that flies **clones**
  while the real DOM is already correct. An anchor registry exposing `useAnchor(id)` — `pile:draw`,
  `pile:discard`, `seat:<id>`, `hand`, `slot:<cardId>` — resolved with
  `getBoundingClientRect()`, which is viewport-space and therefore direction-agnostic, so RTL
  costs nothing.
- **The gotcha that must be respected:** `.game__table` is `container-type: size`
  (`screens.css:257`), which implies `contain: layout` and makes it a containing block for
  absolutely positioned descendants. **The overlay must be a sibling on `.game`**, which needs
  `position: relative`. Rect maths crosses the containment boundary fine.
- **Motions:** remote play `seat → discard`, 240 ms, scale 0.55→1, rotate −6°→0°, face-down for
  the first 90 ms then swapping to the face — that reveal is what makes it read as somebody
  playing *at* you. Local play `slot → discard`, 170 ms, fired **optimistically on tap at
  0 ms**: this is the only way a client gets responsiveness at 40 ms RTT, and it is safe
  precisely because the overlay owns nothing — a rejected move needs `clone.cancel()` and the
  existing refusal callout, not a rollback.
- **Acceptance:** total choreography for one beat ≤ 350 ms; input never gated; a state update
  mid-flight never rolls anything back; with WAAPI absent the table renders exactly as today.
- **Tests:** component — the overlay mounts, and with no WAAPI produces no DOM change. Unit —
  anchor rect maths and the overlay-local conversion as pure functions.

### T24 — draw flight

- **Change:** `pile:draw → hand` for me, `pile:draw → seat:<id>` for everyone else, face-down
  throughout, 200 ms, 45 ms stagger capped at **4 clones** so a ten-card penalty flies four
  cards rather than ten.
- **Acceptance:** the cap holds at every penalty size; my own draw lands in the hand, not on my
  seat.
- **Tests:** unit — planner output for `cardDrawn` at counts 1, 3, 4, 10.

### T13 — the last card, declared and caught

- **Change:** `lastCardDeclared` gets its own cue at the declaring seat. `lastCardCaught`
  carries `playerId`, `caughtById` and `penalty` — enough for a directed cue from catcher to
  caught, which is the social heart of the game and currently a line of text.
- **Acceptance:** the catch reads as directional; the declaration does not; both work when the
  seat involved is mine.
- **Tests:** unit — planner output for both events, including the case where I am the target.

### T21 — the +2 run escalates

- **Change:** `drawStacked` carries a running `total`. Step the landing cue's magnitude by it so
  the fourth +2 lands harder than the first, and surface the number itself on the pile.
- **Acceptance:** magnitude is monotonic in `total` and capped, so a long run cannot become
  absurd.
- **Tests:** unit — planner magnitude for totals 2, 4, 6, 12 is monotonic and bounded.

### T25 — a +3 sent back

- **Change:** `plusThreeBroken` names both actor and target. Fly the penalty to the breaker and
  then visibly turn it around to the original player — the clearest reading available of "sent
  back at you", and the one card interaction nobody understands on first sight.
- **Acceptance:** the reversal is one continuous motion, not two flights that look unrelated.
- **Tests:** unit — planner emits an ordered pair of flights with the second starting where the
  first ended.

### T17 — hold the win

- **Files:** `src/features/game/state/store.ts`, `src/features/game/ui/screens/GameScreen.tsx`
- **Change:** hold the table ~900 ms after a beat containing `playerWon` — land the final card,
  bloom the winner's seat, dim the rest — then route to the standings. Today the route change
  throws the payoff away mid-landing.
- **Risk to respect:** this gates a screen transition on a timer. It must be impossible for the
  gate to strand a player on the table: the timer is cleared on unmount, and any *other* reason
  to leave the table (a close, an error, an abandon) bypasses it entirely.
- **Acceptance:** the standings still always arrive; the hold never exceeds 900 ms; a
  disconnection during the hold routes immediately.
- **Tests:** component — fake timers, assert the screen changes after the hold and immediately
  on a close during it. This is the one task where I will write the failure case first.

### T28 — the recycle

- **Change:** `drawPileRecycled` carries `count`. 420 ms: the discard clone shrinks and slides
  to the draw pile while the depth stack from T19 re-inflates.
- **Acceptance:** fires once per recycle, never on a normal draw.
- **Tests:** unit — planner output for `drawPileRecycled`.

---

## Wave 5 — sound and haptics

### T10 — the synth

- **Files:** `src/lib/audio.ts` — new; `src/app/SettingsDialog.tsx`;
  `src/features/game/state/persistence.ts`; `src/i18n/{he,en}.ts`
- **Change:** a WebAudio cue engine built from oscillators and generated buffers. **No audio
  file of any kind**: the CSP declares no `media-src`, so `default-src 'self'` applies and even
  a `data:` URI in `<audio>` is blocked — while WebAudio performs no fetch at all and is
  outside CSP's scope entirely. It is also smaller: six 40 ms WAVs base64-encoded are ~8 kB
  that barely compress; the synth is ~2.2 kB raw for all cues.
- **Preference:** persisted, defaulting **on**, as a third toggle in the existing settings
  sheet beside theme and language. Peak gain 0.25 — a card game that is loud is a card game
  that gets muted permanently after two rounds.
- **Acceptance:** no network request; no bytes of audio asset; toggle persists across a reload;
  absent `AudioContext` is a no-op, not a crash.
- **Tests:** `tests/unit/lib/audio.test.ts` — new. A stub `AudioContext` records the cues
  requested; assert one cue per event, the gain ceiling, and that a missing `AudioContext` is
  survived silently.

### T15 — the cue map

- **Change:** seven of the twenty-two events get a cue: `cardPlayed` (a band-passed noise burst,
  70 ms), `cardDrawn` (the same, quieter, pitched down ~15 %, 45 ms), `turnChanged` **to me** (a
  two-note rise, 90 ms), a penalty landing on me (a descending three-note, 220 ms),
  `lastCardDeclared` (a bright ping, 120 ms), `lastCardCaught` (a distinct gotcha), `playerWon`
  (a four-note arpeggio, 600 ms).
- **Explicitly no cue** on an opponent's draw (too frequent), on any UI tap, or on an illegal
  card — a buzzer for a mistap is punishment for a UI we designed.
- **Acceptance:** the map is data, derived by the same pure planner, so it is testable without
  audio hardware.
- **Tests:** unit — the cue for each of the twenty-two event types, including the sixteen that
  are deliberately silent.

### T16 — lifecycle, and iOS in particular

- **Change:** `resume()` the context on the Start/Join gesture — **not** the first card tap,
  because `resume` is async and would swallow or delay its own first cue. Do **not** set
  `navigator.audioSession.type`: iOS honours the hardware mute switch for WebAudio and a player
  who silenced their phone meant it. On `visibilitychange`, resume on return and **drop every
  cue for beats that arrived while hidden** — otherwise a returning player gets six sounds at
  once, which is the most common WebAudio bug in web games.
- **Acceptance:** one `resume()` per session; no cue survives a backgrounded period; the mute
  switch is respected.
- **Tests:** unit — hidden-period cues are dropped; `resume` is called once.

### T20 — sound does not fight the announcer

- **Change:** `GameScreen` already pushes one `announce()` per beat into a live region. Duck or
  gate cues so a screen-reader user is not getting speech and audio competing on every move.
- **Acceptance:** with a live-region announcement pending, cues are suppressed or attenuated.
- **Tests:** unit — a cue requested in the same beat as an announcement is attenuated.

### T27 — haptics

- **Change:** Android only, two moments: a penalty landing on me (`vibrate(30)`), and my turn
  beginning when the document was hidden or idle > 8 s (`vibrate([0,20,60,20])`).
  **iOS Safari has never implemented the Vibration API**, so this is feature-detected and
  nothing is designed assuming it exists. Nothing else vibrates — per-tap vibration is where
  this feature always goes to die.
- **Acceptance:** absent `navigator.vibrate` is a no-op; exactly two triggers exist.
- **Tests:** unit — both triggers, and the absence path.

---

## Test strategy

The repo's existing standard is the bar: 678 tests, engine at 99.6 % statements, a coverage
ratchet that fails the build on regression. This plan does not lower it.

1. **Purity where possible.** `choreograph.ts` holds every decision about what animates, so
   almost all of this plan is tested as a pure function over a `Beat` — no DOM, no timers, no
   audio hardware. That is deliberate: it is the only way twenty-nine tasks get real coverage.
2. **The jsdom path is the regression that matters.** `element.animate` is `undefined` under
   test, so every component test exercises the no-WAAPI branch. If the table renders identically
   with motion absent, motion cannot have broken the product — and that is asserted, not hoped.
3. **After every task:** `npm run format:check && npm run lint && npm run typecheck && npm test`.
   No task is considered done with any of those red.
4. **After every wave:** `npm run test:coverage` (thresholds enforced) and `npm run build`
   with the byte delta recorded against the baseline table above.
5. **Playwright for what only a browser can answer:** the turn-row height in both states (T6),
   no stranded hover after a touch tap (T2), the ring geometry (T14), and that the game screen
   still never scrolls at 320×568 through 1280×900 with every new cue present.
6. **New coverage floors** for `choreograph.ts` and `lib/audio.ts`, set just under where they
   land, following the ratchet convention already in `vitest.config.ts`.

---

## Exit criteria

- All 29 tasks done, or explicitly cut with the reason recorded here.
- `npm run verify` green: format, lint, typecheck, coverage thresholds, build.
- Playwright green on desktop and mobile projects.
- Bundle inside the ceiling: +12 kB raw JS, +4 kB raw CSS, +5 kB gzip.
- Every new cue correct in Hebrew RTL and English LTR, light and dark, at 320 px and in
  landscape.
- With `prefers-reduced-motion: reduce`, every state change still produces a visible cue — which
  is strictly better than today, where it produces none.
- No infinite animation anywhere except the connection-health dot.
- No external asset, no network request, no animation or audio library.
