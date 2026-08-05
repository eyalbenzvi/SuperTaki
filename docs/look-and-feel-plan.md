# Look and feel — plan of record

Goal: **the table should be felt, not only read.** Today a move changes a number, a colour and
a truncated line of text. Every fact is available and none of it arrives as a sensation. This
plan adds motion, depth and sound to the table without touching a rule, a wire format or the
engine.

Twenty-nine tasks were proposed. **Twenty-seven are planned; two are cut, with the reasons
recorded in [Cut](#cut).** Five waves. Every task names the file it edits, what "done" means,
and the test that proves it. Constraints kept: static site on GitHub Pages, zero third-party
cost, no external asset of any kind, `engine/` stays pure, RTL and LTR identical, both themes,
`prefers-reduced-motion` honoured, and excellent on a 320 px phone.

> **This is v3.** Two review rounds by an external frontend architect. Round one found that three
> of the four substrate pieces had design holes that would have surfaced as rework: `origin` could
> not be derived as described, the planner could not be both pure and do cross-beat compression, and
> the FLIP measured the wrong frame. Two task premises were factually wrong. Round two found three
> blockers in the fixes themselves: T11 silently breaks four existing assertions and neuters two
> end-to-end action guards, T7's edit did not satisfy T7's own acceptance, and T17's epoch guard
> missed the disconnection it was written for. All are addressed here. What the reviews changed is
> recorded in [What the review changed](#what-the-review-changed).

---

## Table of contents

- [Budget and baseline](#budget-and-baseline)
- [What the investigation found](#what-the-investigation-found)
- [What the review changed](#what-the-review-changed)
- [Constraints the code must obey](#constraints-the-code-must-obey)
- [The substrate](#the-substrate)
- [Deliberate deviations from the review](#deliberate-deviations-from-the-review)
- [Cut](#cut)
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

| Artefact | Raw             | Gzip      |
| -------- | --------------- | --------- |
| JS       | 551.05 kB       | 160.63 kB |
| CSS      | 36.69 kB        | 8.04 kB   |
| Tests    | 678 in 38 files | —         |

**Ceiling for the whole programme: +12 kB raw JS, +4 kB raw CSS, +5 kB gzip total.** No
animation library, no audio file, no font, no image. If a task cannot fit, it is cut rather
than allowed to grow the bundle past this.

---

## What the investigation found

Six things that changed the shape of this plan, all verified in the source rather than assumed:

1. **The best cue in the game is already written and unreachable.** `cards.css:266` raises a
   playable card by 10 px — on `:hover` and `:focus-visible` only. A phone fires neither, and
   iOS Safari makes `:hover` _stick_ after a tap, so the one place it does fire on touch leaves
   a card stranded in the air. The task is to drive it from state, not to invent it.
2. **The event vocabulary is far richer than anything consuming it.** `GameEvent` has **23**
   members, already broadcast to every client, carrying exactly the fields motion needs —
   `drawStacked.total`, `plusThreeBroken.targetId`, `lastCardCaught.caughtById`,
   `takiClosed.cardsPlayed`. All of it renders as one truncated line in a ticker.
3. **Two surfaces already animate, and must not be rebuilt.** `.discard` cross-fades its colour
   rail over 240 ms (`cards.css:416`) and `.seat` cross-fades border and background over 240 ms
   (`screens.css:437`). Change Colour is currently the best-animated moment in the app.
   **But `.seat--current` also sets `box-shadow` (`:449`), which is _not_ in that transition
   list — so the turn ring snaps.** Adding one property to `:437` is most of T5.
4. **The turn banner changes `font-size`** between states (`screens.css:593`, `:605`) with no
   transition — a layout property, on the most frequent state change in the game.
5. **`--dur-slow: 380ms` is declared and never used.** Four speeds advertised, three spent.
6. **`.card` sets `overflow: hidden`** (`cards.css:34`), which clips to the padding box. Any cue
   drawn as an outward pseudo-element on a card is invisible. This kills the obvious
   implementation of T19 and constrains T14.

---

## What the review changed

### Two premises were false and their tasks are cut

- **T18 claimed the stylesheet contradicts itself about `declare-pulse`.** It does not.
  `screens.css:852`'s `animation: none` sits inside
  `@media (orientation: landscape) and (max-height: 32rem)` — a deliberate override in a block
  whose own comment explains the information column has ~180 px to work with. The task's
  acceptance was also unsatisfiable ("the only infinite animation") because `.spinner`
  (`components.css:145`) is legitimately infinite and must stay so. And its effect would have
  been a regression: the obligation to declare persists while the player holds one card, so a
  pulse that stops after three cycles goes quiet while the penalty is still live.
- **T22 claimed `components.css:242` was "unwired intent".** It is `.disclosure > summary::after`,
  fully wired by `.disclosure[open] > summary::after` at `:245` — a working disclosure caret with
  nothing to do with the direction chip. The sweep may still be worth building; it is simply new
  work, not the wiring-up of something half-done.

### Round two: three blockers in the fixes themselves

- **T11 breaks the existing suite, silently in two places.** `jest-dom`'s `toBeDisabled()` reads the
  `disabled` attribute and never `aria-disabled`, so four assertions on the draw pile change
  meaning, and two end-to-end helpers that gate an action on `isEnabled()` with no turn guard would
  start clicking out of turn and reporting success. Recorded in T11, which is now done first in Wave
  2 and failure-first.
- **T7's edit did not satisfy T7's acceptance.** Scoping `transition-duration` does nothing for
  `land`, which is an `animation` — so the allowlist has to cover `animation-duration` too, or T8
  and T12 get nothing from the dependency they declare on it.
- **T17's epoch guard missed the case it existed for.** `sessionEpoch` is not incremented by
  `leaveRoom` or by `closed`, and `closed` keeps the screen for every reason except a voluntary
  leave — so a disconnection during the hold would still route to standings. Replaced by a dedicated
  hold token with explicit invalidation.

### Three substrate pieces were wrong

- **`origin` cannot be derived as v1 described, and is cut from `Beat`.** `submit()` records no
  action and `drawCard()` carries no `cardId`, so half the criterion had no mechanism; a
  `cardDrawn` for me is emitted by moves that are _not_ mine (a catch draws my penalty); and
  `ACTION_LOCK_MS` can clear the request before the answer lands. Worse, it collided with T9:
  the optimistic local flight has no `seq`, so the documented key could not dedupe it against
  the beat-driven flight, giving two flights for one card. **Replaced by** a card-keyed
  in-flight registry with a recency window, which T9 needs anyway and which subsumes `origin`.
- **The planner could not be both pure and do cross-beat compression.** A six-card Taki run is
  six accepted commands, so six version bumps, so **six beats** — compressing it is a decision
  about five _other_ beats, which `(beat) => Motion[]` cannot make. And reduced motion read from
  `matchMedia` inside the planner is a DOM read during render, which `react-hooks/purity`
  rejects at error level. **Resolved by** passing scheduler state and `reducedMotion` in
  `options`: the planner stays pure over _(beat, options)_, and both properties become testable.
- **The FLIP measured the wrong frame.** v1 said "capture rects before the beat commits", but on
  a client the hand changes at the `hand` update and the beat is published at the `events`
  update — one commit later. Every delta would have been zero. **Replaced by** a
  last-known-rects ref re-measured whenever the card-id list changes, which removes T3's
  dependency on `beat` entirely.

### Corrections folded into individual tasks

`GameEvent` has 23 members, not 22 (T15). `.hand__slot` is an `<li>`, not a bare div, and
already carries `position: relative` and a hover `z-index` (T3). `.card`'s `overflow: hidden`
makes an outward pseudo-element depth stack invisible, and the draw-pile button carries
`card--playable`, so T14 and T19 would have fought over the same two pseudo-elements (both
retargeted). `aria-disabled` keeps a button focusable — that is the point of choosing it, and
v1's acceptance claimed the opposite (T11). The store has no unmount, so "the timer is cleared
on unmount" was impossible (T17). `playableCardIds` returns breaker ids **when it is not my
turn**, so gating the lift on `isMyTurn` would have missed the most time-critical decision in
the game (T2). `opponents()` filters out the local player, so there is no local seat to bloom on
my own turn (T5, T13).

---

## Constraints the code must obey

Beyond the product constraints, four platform facts shape every task. All four verified.

1. **jsdom implements no Web Animations API.** `element.animate`, `getAnimations`, `Animation`
   and `KeyframeEffect` are all `undefined`; `ResizeObserver`, `AudioContext` and
   `navigator.vibrate` likewise; `matchMedia` is stubbed to `matches: false`; and
   `getBoundingClientRect()` returns all zeros. Every motion path must feature-detect and
   degrade to an instant, correct DOM.
2. **The React Compiler lint rules are on, at error level.** `eslint-plugin-react-hooks@7.1.1`
   is installed and `eslint.config.js` spreads `reactHooks.configs.recommended.rules`, which
   sets all sixteen rules — including `purity`, `globals`, `refs`, `immutability`,
   `set-state-in-effect` and `preserve-manual-memoization`. `npx eslint .` is green today, so
   these are enforced. Consequences: no global read during render (the planner takes
   `reducedMotion` as an argument); no ref written during render; **T8's flash must be a `key`
   remount, not `useState` in an effect**; and `beat` must be subscribed with its own
   `useAppStore(s => s.beat)` selector rather than folded into `GameScreen`'s `useShallow`
   object, because widening that object changes `table`'s identity on every beat and silently
   defeats the `useMemo(() => opponents(table), [table])` at `GameScreen.tsx:91`.
3. **`Animation.cancel()` rejects `finished` with an `AbortError`,** and the backlog cap cancels
   in flight by design. With `@typescript-eslint/no-floating-promises` on via
   `recommendedTypeChecked`, `anim.finished.then(...)` is also a lint error. Use
   `onfinish`/`oncancel`. jsdom hides this entirely, so it would only appear in a browser.
4. **Coverage ratchets are per-path, not global.** New files under `src/features/game/ui/` and
   `src/lib/` fall under no existing threshold, so uncovered new code cannot go red — which is a
   reason for discipline, not relief. The one real exposure is `store.ts` at statements 78 /
   branches 60: T1 and T17 both add branchy code there, so coverage is checked after each of
   those two tasks specifically, not only at the end of the wave.

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
  readonly seq: number; // monotonic, minted like feedCounter
  readonly events: readonly GameEvent[];
  readonly from: TableSignature | null; // the table before this move
  readonly to: TableSignature; // the table after it
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

`from` is captured in the `publicState` case, before the new state overwrites the old.

**There is no `origin` field.** v1 had one and it was the least reliable thing in the substrate
(see [What the review changed](#what-the-review-changed)). Where a local/remote distinction is
genuinely needed it is derived from the event itself — `event.playerId === localPlayerId` — which
needs no request tracking at all. Where it is needed to avoid animating the same card twice, T9's
in-flight registry answers it directly: keyed on `${kind}:${cardId}` with a 400 ms recency
window, a beat-driven flight is a no-op when a live clone already owns that card.

**Dedupe: at most one beat per `publicState` version.** One accepted command is one version
bump, so the version is the natural identity of a move. This has to be enforced in the store
because it cannot be pushed down: `clientSession.ts:672` drops event batches on
`version < lastEventVersion` — strictly less-than, so an exact-version replay after a reconnect
passes straight through, and `SessionUpdate`'s `events` member carries no version at all.

`beat` must be declared in `initialState()`. `resetStore` replaces state wholesale
(`useAppStore.setState({...PRISTINE}, true)`), so a field added anywhere else vanishes in every
component test. And `beatCounter` is a module-level `let` like `feedCounter`, which `resetStore`
does not touch — so tests assert that `seq` strictly increases, never that it equals 1.

**The invariant that makes all of this safe: the real DOM is always the authoritative
post-state, and motion is a lie told on top of it by a layer that owns nothing.** A snapshot
arriving mid-flight never has to roll anything back, because nothing in flight is load-bearing.

### `choreograph.ts` — a pure planner

`(beat, options) => readonly Motion[]`, where

```ts
interface ChoreographOptions {
  readonly localPlayerId: string | null;
  readonly reducedMotion: boolean; // passed in, never read from matchMedia here
  readonly inFlight: readonly string[]; // motion keys currently on screen
  readonly lastPlayedSeq: number; // the newest beat the view has actually played
}
```

No DOM, no refs, no React, **no global reads** — the same shape as `handLayout.ts` and
`eventText.ts`, so "does a +3 broken by a breaker produce the right two flights" is a vitest
assertion rather than something verified by playing. The scheduler state arrives as data, which
is what lets the cross-beat rules below stay in a pure function and stay testable.

```ts
type Motion =
  | {
      kind: 'flight';
      key: string;
      from: AnchorId;
      to: AnchorId;
      card: Card | null;
      faceDown: boolean;
      delayMs: number;
      durationMs: number;
    }
  | {
      kind: 'pulse';
      key: string;
      at: AnchorId;
      tone: 'danger' | 'success' | 'neutral';
      delayMs: number;
      durationMs: number;
    }
  | { kind: 'sweep'; key: string; direction: 1 | -1; durationMs: number };
```

Interruption rules live here, not in the view. They are **one rule, not two** — v1 stated a
backlog cap and a run-compression forty lines apart as if they were different situations:

- **Never block, never roll back.** Input is never gated on motion.
- **One catch-up rule.** A Taki run is six commands, so six beats, so six chances to fall
  behind. If `beat.seq - options.lastPlayedSeq > 2`, the view is behind: emit only the newest
  beat's motions and drop the intermediate ones. That is what "fly the first and last card of a
  run, skip the middle" means in practice — it is the _same_ rule, expressed over beats rather
  than over cards, and it is why `lastPlayedSeq` has to be an input.
- **Keyed and idempotent.** `key = ${seq}:${kind}:${cardId}`, and any key already in
  `options.inFlight` is not re-emitted. This is what makes a replayed beat harmless and what
  stops T9's optimistic local flight being doubled by the beat that follows it.
- **Reduced motion substitutes rather than empties.** With `options.reducedMotion` the planner
  returns opacity-only motions, never `[]`, because the comprehension the motion buys must
  survive. The flag is passed in; reading `matchMedia` here would be a `react-hooks/purity`
  error and would make the function untestable without stubbing a global.

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

**1. The beat is a derived signal, not a coalescing buffer.** The game-feel review asked for the
three updates to be buffered and flushed on a microtask, to collapse three React commits into
one. This plan refuses, and the plan reviewer independently confirmed the reasoning after
tracing both paths.

First, the microtask buffer does not work as prescribed: on a client the three payloads are
dispatched from three separate `message` events (`clientSession.ts:651`, `:664`, `:677`) — three
_macrotasks_ — and a microtask flush only coalesces writes made within one task. On the host all
three fire synchronously inside one React `onClick`, so React already batches them into a single
commit and there is nothing to fix. Second, the payoff is small: `CardBody` is memoised on card
identity (`CardView.tsx:42`), so a `publicState` commit does not rebuild glyph geometry, and
three renders arriving from one SCTP write paint once. Third — and this is the part that settles
it — **the store cannot correlate by version even if it wanted to**, because `SessionUpdate`'s
`events` member carries no version field at all.

So the _information_ problem the review correctly identified — no single place sees `from`, `to`
and `events` together — is solved by the derived beat at zero latency and zero risk to 678 tests.

Two things to record rather than hide. If measurement ever forces real coalescing, it belongs in
**`clientSession`, not the store**: all three wire payloads _do_ carry a version
(`publicState.state.version`, `privateHand.hand.version`, `gameEvents.payload.version`), so a
version-keyed coalescer with a short timeout is buildable there and nowhere else. And there is a
genuine inconsistent intermediate state on the client between commit 1 and commit 2 — the played
card is in `publicState.discardTop` while still in `hand`, so for one render it exists in two
places. It does not paint, but it _does_ run every `useLayoutEffect` in the tree synchronously.
T3 is the task that has to be correct in the face of that, and it is why T3 no longer keys off
the beat.

**2. `.discard` keeps its colour transition; `.seat` gets one property added.** The review
described the seat's turn state as "a static tint that is either on or off". Both surfaces
already cross-fade border and background over 240 ms — but `.seat--current` also sets
`box-shadow` (`screens.css:449`) and `box-shadow` is _not_ in the transition list at `:437`, so
the turn ring does snap. The reviewer was half right. Adding one property to an existing
transition list buys most of what a JS ring bloom would, for zero bytes and with no WAAPI
dependency, and that is what T5 now does. The Change Colour moment is left alone entirely.

---

## Cut

Two of the twenty-nine proposed tasks are not being built.

**T18 — bound the `declare-pulse`.** Its premise was false: `screens.css:852` is a deliberate
landscape override inside `@media (orientation: landscape) and (max-height: 32rem)`, not a
contradiction. Its acceptance was unsatisfiable: `.spinner` (`components.css:145`) is
legitimately `infinite` and must stay so, and it is not the health dot. And the change would
have been a product regression — the obligation to declare persists for as long as the player
holds a single card, so a pulse that stops after three cycles goes quiet while the penalty is
still live. If it is ever revisited, the shape is "re-key the pulse on each turn change" so it
pulses three times _per turn_, and the `:852` override stays exactly where it is.

**T29 — adopt or retire `--dur-slow`.** Enforcing "no unused motion token" needs a test that
reads a stylesheet from disk: `tests/unit/i18n.test.ts` does no file I/O, and vitest runs with
`css: false`, so no stylesheet is in the module graph. That is new test machinery for one token.
Instead: T9, T17 and T28 adopt 380 ms where it fits, and if none of them ship, the token is
deleted in a one-line commit. Outcome, no infrastructure.

---

## Wave 0 — substrate

Nothing visible ships in this wave. It exists so that the twenty-six tasks after it are small.

### T1 — `beat` in the store

- **Files:** `src/features/game/state/store.ts`, `src/features/game/state/selectors.ts`
- **Change:** add `Beat`/`TableSignature` **to `initialState()`**, capture `from` in the
  `publicState` case, publish `beat` in the `events` case, and refuse to publish twice for one
  `publicState` version. Clear `beat` wherever `feed` is already cleared (three sites: new round,
  resume, leave). No `origin` field — see the substrate section.
- **Acceptance:** one beat per accepted command; `seq` strictly increasing; `from` is `null` only
  for the first beat of a round; an event batch replayed at a version already seen mints no
  second beat.
- **Tests:** `tests/unit/state/beat.test.ts` — new. Drive the store through a memory-transport
  session and assert the sequence, the signatures, and the replay case. `seq` is asserted
  strictly increasing, never equal to 1: `beatCounter` is a module-level `let` like
  `feedCounter` and `resetStore` does not reset it.
- **Coverage:** check `store.ts` against its 78/60 floor immediately after this task, not at the
  end of the wave.

### T4 — `choreograph.ts` and the interruption rules

- **Files:** `src/features/game/ui/choreograph.ts` — new
- **Change:** the pure planner, `ChoreographOptions` and the `Motion` union above, covering every
  event this plan animates. The single catch-up rule, keying against `inFlight`, reduced-motion
  substitution.
- **Acceptance:** pure — no import from `react`, no DOM reference, **no global read** (a
  `matchMedia` call here is a `react-hooks/purity` error). With
  `beat.seq - lastPlayedSeq > 2` only the newest beat's motions are emitted. A key present in
  `inFlight` is never re-emitted. `reducedMotion` yields opacity-only motions, never `[]`.
- **Tests:** `tests/unit/ui/choreograph.test.ts` — new, table-driven over **all 23**
  `GameEvent` members (both the animated ones and those deliberately silent), plus the catch-up
  rule, the `inFlight` suppression, and the reduced-motion path.

### T7 — reduced motion decided in JS

- **Files:** `src/lib/motion.ts` — new; `src/styles/base.css`
- **Change:** `prefersReducedMotion()` reading `matchMedia` (in a hook or a plain function called
  from an effect — never during render), and the `animate` wrapper.
- **The `base.css:261` edit is bigger than v1 admitted.** That rule is **property-blind**: it
  zeroes `animation-duration`, `animation-iteration-count` and `transition-duration` with
  `!important` for `*`, `*::before` and `*::after`. It cannot be "narrowed to keep killing
  transforms" — it does not know what a transform is. Allowing a short opacity fade means
  replacing the blanket rule with per-property scoping, which touches every transition in the
  app. **And the allowlist must cover `animation-duration`, not only `transition-duration`.** v2
  scoped only transitions, which would have left `land` (`animation: land var(--dur-base)`,
  `cards.css:445`) dead and so failed T7's own acceptance — and taken T8 and T12 with it, since both
  are CSS _animations_ replayed by a `key` remount, not transitions. So: replace both blanket kills
  with an allowlist that keeps short `opacity` and `background-color` transitions **and** a named
  set of short keyframe animations, and keep zeroing everything else. Verified against all eight
  existing `transition:` declarations — `base.css:143`, `components.css:27`, `components.css:242`,
  `cards.css:220`, `cards.css:416`, `cards.css:525`, `screens.css:437`, `screens.css:523` — before
  landing.
- **Acceptance:** with reduced motion on, every state change still produces a visible cue —
  currently it produces **none**, because the blanket rule kills both `land` and the discard
  cross-fade and the ticker swaps silently. With reduced motion off, computed styles are
  unchanged everywhere.
- **Tests:** `tests/unit/lib/motion.test.ts` — new. `animate` returns `null` without WAAPI;
  `prefersReducedMotion` reads the query; `choreograph` with `reducedMotion: true` yields
  opacity-only plans. Playwright asserts a non-zero `transition-duration` on the ticker pill and
  a zero one on a transform, under an emulated `prefers-reduced-motion: reduce`.
- **Ordering:** T7 must land before T5, T8, T12 and T23 — every one of them claims a cue that
  survives reduced motion, and none of them do until this rule is scoped.

---

## Wave 1 — repairs to motion that already exists

Six tasks, no new subsystem, no new bytes of consequence. This is the cheapest feel improvement
in the plan and it ships first.

### T2 — the playable lift, driven by state

- **Files:** `src/styles/cards.css`, `src/features/game/ui/components/TableParts.tsx`,
  `src/features/game/ui/screens/GameScreen.tsx` (`Hand` receives `cards`, `playableIds`,
  `locked` and `disabledReason` and nothing else, so the new flag has to be threaded)
- **Change:** wrap the existing `:hover` rule at `cards.css:266` in
  `@media (hover: hover) and (pointer: fine)`. Add a state-driven lift on the same cards,
  staggered 25 ms per slot, transitioned over 260 ms.
- **Gate on "any playable card", not on `isMyTurn`.** `playableCardIds`
  (`selectors.ts:65-82`) returns breaker ids when a `plusThree` is open **and it is not my
  turn** — the most time-critical decision in the game, and exactly what the lift is for.
- **Resolve the transform conflict rather than layering rules.** `button.card:active` sets
  `transform: scale(0.96)` at specificity (0,2,1). A new `.hand--armed .card--playable` rule is
  (0,2,0) and would _lose_ to `:active`, so pressing would drop the card. The existing hover rule
  is (0,3,1) and already _beats_ `:active`, so a hovered playable card has no press feedback at
  all today. Compose both into one declaration driven by custom properties —
  `transform: translateY(var(--lift, 0)) scale(var(--press, 1))` — so lift and press coexist.
  **`button.card:active` therefore stops setting `transform` at all and sets `--press: 0.96`
  instead**; if it keeps its own `transform` the composition is dead on arrival. Focus then needs a
  _deeper_ lift than the resting one, or `:focus-visible` becomes a no-op.
- **The stagger must not ride on `transition-delay`.** Once lift and press are the same property
  they cannot carry different delays, so a 25 ms-per-slot `transition-delay` would leave a card in
  slot 10 waiting 250 ms before it responds to a tap — an input-feel regression on the primary
  interaction of the product, caused by the very fix for the specificity war. The arming wave is a
  one-shot event rather than a state transition, so it is a one-shot `@keyframes` with
  `animation-delay: var(--lift-delay)`, and `transition: transform` stays delay-free for press and
  focus.
- **320 px and landscape.** `.hand` has `padding-block: 14px` (`cards.css:328`), cut to 12 px at
  `max-height: 40rem` and to **8 px** in landscape (`screens.css:842`), and `.game__hand` is
  `overflow-y: auto`. A permanent 10 px lift will clip or introduce a scrollbar in landscape, and
  `tableLayout.spec.ts`'s `cardsOutsideViewport` assertion is checked at 780×360. The lift cannot
  be "a fraction of the padding" in CSS — `padding-block` is a hard px value in all three places —
  so a `--hand-lift` is declared beside each. **T2 therefore edits three media-query blocks across
  two files, not one rule.**
- **Acceptance:** when I hold a playable card, those cards rise once, in sequence, and stay up;
  unplayable cards do not move; pressing a lifted card still gives press feedback; keyboard focus
  lifts further; nothing is clipped at 320 px or in landscape.
- **Tests:** `tests/component/table.test.tsx` — the armed class is present when a playable card
  exists (including the not-my-turn breaker case) and absent otherwise. `tableLayout.spec.ts` —
  no card outside the viewport at 780×360 with the lift active.
- **Honest limit on the iOS claim:** `@media (hover: hover) and (pointer: fine)` suppresses the
  stranded-hover bug on iPhone, which reports `hover: none`, but **iPadOS Safari in
  desktop-class mode reports `hover: hover` and `pointer: fine`** and remains exposed, as do
  Windows touch laptops. Playwright cannot prove otherwise here: the mobile project is
  `devices['Pixel 5']` (Chromium, `hover: none`) and there is no WebKit project, so the test
  passes trivially. Recorded as a known gap rather than claimed as fixed.

### T6 — the turn banner stops jumping

- **Files:** `src/styles/screens.css`
- **Change:** `.turn-banner--mine` no longer changes `font-size`. One size for both states;
  emphasis moves to `scale(1.04)` plus the existing colour change, and the element gains a
  transform/colour transition.
- **Acceptance:** becoming the current player no longer reflows the turn row; the banner is
  still visibly more prominent on my turn; the row's height is identical in both states at
  320 px.
- **Tests:** Playwright — measure `.turn-row` height in both states and assert equality.

### T14 — the playable ring stops repainting the card

- **Files:** `src/styles/cards.css`
- **Change:** move the playable **ring** to an `::after` pseudo-element and transition its
  opacity. The ring is a two-layer inset — `3px var(--card-outline)` plus
  `5px rgb(255 255 255 / 0.95)`, the white deliberately literal so it holds in both themes — and
  the closest equivalent on a pseudo-element is a single `box-shadow` reproducing both layers.
  `::after` needs `position: absolute` to paint above the absolutely positioned `.card__corner`
  elements.
- **What v1 missed:** `.card--playable` (`cards.css:241-248`) replaces the _entire_ box-shadow,
  swapping `--shadow-card` for `--shadow-card-raised` — an **outer** shadow, which cannot live on
  an `::after` inside `overflow: hidden`. So the raised outer shadow must stay on the card, and
  `box-shadow` therefore stays in the `button.card` transition list at `:220` for that one layer.
  Only the ring moves. The saving is real but smaller than v1 claimed: one shadow layer
  transitioning instead of four.
- **Sequencing:** T14 and T19 both want `::before`/`::after` on the draw-pile button, which
  carries `card--playable` whenever `canDraw` (`TableParts.tsx:208`). They are implemented
  together, and T19 moves its depth stack onto a wrapper element to resolve the collision.
- **Acceptance:** the ring is pixel-identical in both themes and at every card size; the raised
  shadow still transitions; no card has two competing `::after` rules.
- **Tests:** Playwright assertion that the ring's computed geometry is unchanged; component test
  that `card--playable` still marks the same cards.

### T26 — softer hand scale steps

- **Files:** `src/features/game/ui/handLayout.ts`
- **Change:** `handCardScale` from two steps to four, so the largest single jump is ~7 % rather
  than 14 %.
- **Acceptance:** existing layout tests still pass at every count; no card is smaller than the
  current minimum at any count.
- **Tests:** `tests/unit/ui/handLayout.test.ts` — extend the existing table with the new
  thresholds and assert monotonic non-increasing scale. The file currently contains **no**
  `handCardScale` assertions, so this task breaks nothing and adds the first ones.
- **Ordering:** T26 must land **before** T3. It changes how often `--hand-scale` steps, which
  changes what T3 has to animate.

---

## Wave 2 — cheap new cues

Seven tasks. Each is small, each is independent of the flight layer, and each survives on its
own if Wave 4 is cut.

### T5 — turn-enter cue

- **Files:** `src/features/game/ui/screens/GameScreen.tsx`, `src/styles/screens.css`
- **Change:** key the banner on `currentPlayerId` so it re-enters — `scale(.96)→1`, opacity,
  `translateY(4px)→0`, 300 ms `--ease-out`. Add **`box-shadow` to the existing `.seat`
  transition list** at `screens.css:437`, which is the whole seat-ring change: `.seat--current`
  already sets a `box-shadow` ring at `:449` that currently snaps because the property is not in
  the list. One property, zero JS, no WAAPI dependency, and it works under reduced motion once T7
  scopes the blanket rule.
- **The incoming seat is sometimes me, and then there is no seat.** `opponents()`
  (`selectors.ts:192`) filters out `localPlayerId`, so `.seats__list` contains no element for the
  local player. On my own turn — the turn that matters most — the banner re-entry _is_ the whole
  cue, and that is correct rather than a gap: the banner already switches to its emphasised state
  and the hand arms itself (T2). Acceptance is written accordingly.
- **Acceptance:** every turn change produces a banner re-entry; when the incoming player is an
  opponent, their seat ring also fades in rather than snapping; nothing animates on the outgoing
  seat; no loop.
- **Tests:** component — the banner's `key` changes with `currentPlayerId`, and no seat element
  exists for the local player. Playwright — computed `transition-property` on `.seat` includes
  `box-shadow`.

### T8 — the ticker announces itself

- **Files:** `src/features/game/ui/components/GameLog.tsx`, `src/styles/screens.css`
- **Change:** a 150 ms background flash on the ticker **pill**, driven by a `key` on the flashing
  element set from the newest entry's id, so a new line remounts it and replays the CSS animation.
  The text is not animated — it is the comprehension fallback and the semantic neighbour of the
  live region.
- **Not `useState` in an effect.** `react-hooks/set-state-in-effect` is at error level, so the
  obvious "watch the id, set a flag, clear it on a timer" implementation will not lint. The `key`
  remount is both cheaper and the only version that passes.
- **Depends on T7.** v1's acceptance claimed the flash survives reduced motion "because it is
  opacity and colour only". That is wrong: `base.css:261` zeroes `transition-duration` and
  `animation-duration` for _every_ property. The flash survives only once T7 has scoped that rule.
- **Acceptance:** a new line flashes once; an unchanged feed does not; the flash survives
  `prefers-reduced-motion` after T7.
- **Tests:** component — the flashing element's `key` advances with a new entry and not
  otherwise.

### T11 — a blocked draw pile explains itself

- **This is the highest-risk task in the plan and the only one that edits the existing suite's
  assertions rather than adding to them.** It is done **first** in Wave 2, and failure-first: change
  the assertions, watch them fail, then change the component.
- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/styles/cards.css`,
  `src/features/game/ui/screens/GameScreen.tsx`, and — not optional —
  `tests/component/table.test.tsx`, `tests/component/game.test.tsx`,
  `tests/e2e/multiplayer.spec.ts`, `tests/e2e/tableLayout.spec.ts`, `tests/e2e/gameplay.spec.ts`
- **What goes red, and why.** `jest-dom`'s `toBeDisabled()` consults the `disabled` **attribute**
  only and never `aria-disabled`, so removing it turns three passing assertions red —
  `table.test.tsx:88`, `game.test.tsx:205`, `game.test.tsx:216` — and makes a fourth vacuous,
  `game.test.tsx:199`'s `toBeEnabled()`. Those four become
  `toHaveAttribute('aria-disabled', 'true'|'false')`.
- **What goes quietly wrong, which is worse.** Three e2e helpers gate an action on
  `isEnabled()` — an actionability check keyed on the `disabled` _property_, which would become
  always-true. `tableLayout.spec.ts:76` survives because it has an `onTurn(actor)` guard in front of
  it, but `gameplay.spec.ts:81` and `tableLayout.spec.ts:205` have **no** turn guard and fall
  through to clicking the pile, then report that they acted. In `gameplay.spec.ts` that means the
  round driver clicks out of turn, collects a refusal, claims success and stalls until
  `ROUND_BUDGET_MS` expires — a timeout in the longest test in the suite, presenting as a flake.
  Both get an explicit turn guard instead of `isEnabled()`.
- **Unverified, so check it:** Playwright's `toBeDisabled()` is documented to honour
  `aria-disabled`, which would keep `multiplayer.spec.ts:181` passing. That was not confirmable from
  the installed package, so it is verified by running it, not assumed.
- **Note the written record being inverted:** `multiplayer.spec.ts:174` is named _"disables the draw
  pile and hand when it is not your turn"_ and its comment at `:183` explains that cards stay
  focusable by reference to `PlayableCard`. That test documents the policy this task extends to the
  pile, so its name and comment are updated with it.
- **Change:** replace the real `disabled` attribute at `TableParts.tsx:208` with
  `aria-disabled` plus a click handler that surfaces `drawBlockedReason`, matching the pattern
  cards already use through `onRefuse`. A disabled button gets no `:active`, no press feedback,
  and its `title` is unreachable on most browsers — so today the tap is a silent dead end while
  an illegal _card_ tap explains itself.
- **Be honest about the accessibility trade, which v1 got backwards.** `aria-disabled="true"` on
  a `<button>` **keeps it focusable and in the tab order** — that is precisely why it is chosen
  over `disabled`, and it is the trade `PlayableCard` already made deliberately
  (`CardView.tsx:99-108`). So this adds a permanent tab stop between the table and the hand for
  every state in which the pile is blocked, which is most of the game. That is the right call for
  consistency with cards, but it is a cost, not a free win, and v1 claimed both.
- **The accessible name is a count, not a reason.** `aria-label` is
  `countLabel(t, 'game.drawPileAria', drawPileCount)` (`TableParts.tsx:211`), so a screen-reader
  user landing on the new tab stop hears a number. The blocked reason moves from the unreachable
  `title` into an `aria-describedby`, and the tap routes through `announce()` — which is what the
  card path already does.
- **One real regression to avoid.** `refusal` **replaces the entire `ActionPrompt`** for
  `REFUSAL_MS = 2600` (`GameScreen.tsx:225-249`). Tapping a blocked pile would therefore hide the
  prompt that explains what to do instead — and the most common blocked case is "not your turn",
  where that prompt is the only useful thing on screen. The refusal for this path renders
  _alongside_ the prompt rather than replacing it.
- **Also:** `canDraw` is false while `actionPending` too (`GameScreen.tsx:176`), so the handler
  fires during send and will say "sending". Harmless, but it means the path is hit more often
  than v1 implied.
- **Acceptance:** tapping a blocked pile explains itself the way a blocked card does, without
  hiding the action prompt; the reason is available to a screen reader; `canDraw` behaviour is
  otherwise unchanged.
- **Tests:** component — tap a blocked pile, assert the reason appears, the action prompt is
  still rendered, and no `drawCard` intent is submitted.

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
- **v1's implementation cannot work.** `.card` sets `overflow: hidden` (`cards.css:34`), which
  clips to the padding box, so backs offset _outward_ via `::before`/`::after` on the card are
  invisible. Removing `overflow: hidden` is not an option — the glyph and corners depend on it.
  And the draw-pile button carries `card--playable`, so those two pseudo-elements are also T14's.
- **Change:** the depth stack goes on a **new wrapper element** around the draw-pile button inside
  `.pile`, with `--depth` bucketed from `drawPileCount` (>30, >15, >5, ≤5 → 3 px, 2 px, 1 px, 0).
  A 160 ms lift-and-settle on tap replaces the generic `scale(0.96)` for this one control, setting
  the same `--press` custom property T2 introduces so the two do not fight. (The pile is a
  `button.card` but is not inside `.hand`, so it never receives `--lift` and does not inherit T2's
  arming rule.)
- **Two conditions make the wrapper safe, and they are the whole safety argument.** `--card-w-lg`
  is solved as `clamp(1.5rem, min(calc((100cqh - var(--pile-chrome)) / 1.5), 30cqi), var(--pile-max))`
  (`screens.css:292`), where `--pile-chrome` is a hand-measured constant for everything in the
  column that is not the card — declared **four times** with four values (`screens.css:290`, `:307`,
  `:315`, `:349`). If the wrapper contributes _any_ block size, all four become wrong at once, the
  card is sized too large for its space, and `.piles` overflows `.game__table` — exactly the sliced
  pile panel that `tableLayout.spec.ts`'s `panelOverflow` assertion exists to catch, and it bites
  hardest at 320 px and in landscape where the `clamp` actually binds. Therefore:
  1. **The wrapper replaces the button as a direct child of `.pile`, never sits beside it.** `.pile`
     is a flex column with `gap: var(--space-1)` and three children today, so two gaps; wrapping
     keeps three children, while adding a fourth would add a gap and invalidate all four constants.
  2. **The depth stack is absolutely positioned pseudo-elements on a `position: relative` wrapper,
     contributing zero layout**, offset _inward_ (down-and-trailing, inside `.piles`'s padding)
     rather than outward — which is both how a real deck reads and what keeps it clear of
     `.game__table`'s `overflow: auto` at `:266`.
- With those two conditions the `panelOverflow` exposure is nil: `measure()` reads
  `rect('.piles').height`, and `getBoundingClientRect()` returns the element's own border box
  without unioning overflowing absolutely positioned descendants.
- **Acceptance:** the deck visibly thins as the round runs; the stack is visible (i.e. not
  clipped); tapping feels like pulling a card off; the count text and the playable ring are
  unchanged; nothing shifts the `.piles` layout at 320 px.
- **Tests:** component — the depth bucket for representative counts, and that the wrapper does not
  change the pile's accessible output. Playwright — `.piles` geometry unchanged at 320 px.
- **Sequencing:** implemented together with T14.

### T22 — direction reversal is spatial

- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/styles/screens.css`
- **Change:** on a `directionChanged` beat, sweep a 12 px translucent band across `.seats__list`
  in the new direction over 280 ms, and rotate the direction chip 180°. This is entirely new
  work — v1 claimed `components.css:242` was unwired intent for this, but that is
  `.disclosure > summary::after`, a working caret driven by `.disclosure[open]` at `:245`, with
  nothing to do with the chip.
- **The RTL trap, which the planner's own test would hide.** `direction: 1 | -1` means "follows
  the seating order", which is visually left-to-right in LTR and **right-to-left in RTL**, because
  `.seats__list` is a plain flex row whose visual order reverses under `dir="rtl"`. A unit test
  asserting "the planner emits a sweep with the right sign" would pass while the animation runs
  backwards in Hebrew — the app's default language. So the planner emits a _logical_ sign and the
  view multiplies by the document direction, and that multiplication is what the test covers.
- **Acceptance:** a Change Direction card produces one sweep, in the correct visual direction, in
  **both** RTL and LTR; nothing sweeps on any other event.
- **Tests:** unit — the planner's logical sign for `directionChanged`, and the view's
  direction-multiplication as a pure function, asserted for both `ltr` and `rtl`. Playwright —
  the sweep's travel direction in Hebrew and in English.

### T23 — a penalty that lands on me

- **Files:** `src/features/game/ui/screens/GameScreen.tsx`, `src/styles/screens.css`
- **Change:** one 120 ms `--danger-soft` flash behind the hand area when a beat's penalty
  targets `localPlayerId`. Once. Not a shake.
- **Acceptance:** fires for a penalty aimed at me and never for one aimed at somebody else.
- **Tests:** unit — planner emits a `pulse` at the `hand` anchor only when the target is me.

---

## Wave 3 — the hand

### T3 — FLIP the hand

This is the most underestimated task in the plan, and the reason is Deviation 1. It is budgeted
at 3–4× the obvious estimate and sequenced **after T26** and after T2's transform conflict is
resolved.

- **Files:** `src/features/game/ui/components/TableParts.tsx`, `src/features/game/ui/handFlip.ts`
  — new, `src/styles/cards.css`
- **Not beat-driven.** v1 said "capture rects before the beat commits". On a client the hand
  changes at the `hand` update and the beat is published one commit later at the `events` update —
  so every captured rect would already have moved and every delta would be zero. Instead: keep a
  ref of last-known rects and re-measure in a layout effect whenever the **card-id list** changes,
  animating current-versus-remembered. This works regardless of how many commits an update takes
  and removes T3's dependency on `beat` entirely.
- **The solver runs in two commits and the FLIP has to survive both.** `useHandLayout`
  (`TableParts.tsx:259-280`) re-solves in a `useLayoutEffect` keyed on `[count]` and calls
  `setLayout`, producing a second render with new `--hand-per-row`/`--hand-strip`/`--hand-card`.
  But `--hand-scale` is computed inline from `cards.length` in the _same_ render (`:374`), so it
  lands one commit **earlier** than the strip. A count change therefore produces commit N (new
  scale, stale strip) → layout effect → commit N+1 (final positions) — and `setLayout` returns
  `previous` when nothing changed (`:269-272`), so sometimes there is no commit N+1 at all.
  Measuring in commit N animates toward the wrong target and then jumps. The FLIP must defer until
  the strip and the scale agree, and handle both shapes. That is a small state machine, not a
  transform.
- **Scale is part of the delta.** T26 adds thresholds, so more counts resize every card. A
  translate-only FLIP is wrong across a resize, and the scale lives on `.card` (`--card-width` via
  `--hand-scale`, `cards.css:340`) while the animation runs on the slot — transforming the slot
  cannot compensate for the card resizing inside it. The delta carries both, and the scale
  component is applied where the size actually changes.
- **Two non-negotiables**, both about the target hardware: animate the **`.hand__slot`** — an
  `<li>` (`TableParts.tsx:392`) that already carries `position: relative` and a hover
  `z-index: 20`, so not quite the bare element v1 implied, but still far cheaper than the card —
  never the `.card`, which carries a four-layer shadow and five extruded SVG glyph groups. And
  drop `will-change` in the animation's `finish` handler; fourteen permanently promoted layers is
  how a 60 fps budget is lost.
- **Acceptance:** paying a four-card penalty reflows the hand as motion rather than a teleport; no
  layout property is animated; there is no double-move when the solver re-solves; the solved
  layout is byte-identical to today's at rest.
- **Tests:** unit — `handFlip.ts`'s delta calculation as a pure function, including the
  scale-change case and the "strip not yet settled" case. This is the only real test here, and the
  plan says so plainly: in jsdom `ResizeObserver` is `undefined` so `useHandLayout` returns early
  and `layout` stays `UNMEASURED` in every component test, and all rects are zeros — so "the hand
  renders identically with WAAPI absent" is trivially true and **cannot fail**. It is still
  asserted as a regression guard, but it proves much less than v1 claimed.

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
  (`screens.css:257`), which computes to `contain: size layout style` and makes it a containing
  block for absolutely _and_ fixed positioned descendants. It is also `overflow: auto` (`:268`),
  so an overlay inside it would be clipped even without containment — two independent reasons.
  **The overlay must be a sibling on `.game`**, which needs `position: relative`. Rect maths
  crosses the containment boundary fine.
- **Four more things about `.game` that v1 missed:**
  1. In `@media (orientation: landscape) and (max-height: 32rem)` (`screens.css:787`), `.game`
     becomes a `grid` with explicit `grid-template-areas` and every child assigned an area. An
     out-of-flow overlay claims no cell — but an overlay that ever renders _without_
     `position: absolute` (an early return producing a bare `<div>`) auto-places into an implicit
     row and pushes the hand off screen. The positioning is therefore unconditional **in CSS**,
     never applied conditionally from JS.
  2. `inset: 0` resolves against `.game`'s **padding box**, and `.game` has padding. The
     overlay-local conversion subtracts the _overlay's own_ rect, never `.game`'s.
  3. `.game__hand` (`max-block-size: 52svh; overflow-y: auto`) and `.seats__list`
     (`overflow-x: auto`) are scroll containers, so a `slot:<cardId>` anchor for a card scrolled
     out of view resolves off-screen. Flights whose source anchor falls outside the overlay rect
     are dropped rather than flown in from nowhere.
  4. Making `.game` `position: relative` was checked against its absolutely positioned
     descendants: the only one whose containing block changes is `.direction-chip__label` in
     `@media (max-width: 26rem)` — active at 320 px — and it sets no inset properties, so it keeps
     its static position. Verified, not assumed.
- **Use `onfinish`/`oncancel`, never `Animation.finished`.** `cancel()` rejects `finished` with an
  `AbortError`, and the catch-up rule cancels in flight by design — so `.finished.then(...)` would
  produce unhandled rejections in a browser while being completely invisible in jsdom, where
  `animate` returns `null`. It is also a `no-floating-promises` lint error.
- **Motions:** remote play `seat → discard`, 240 ms, scale 0.55→1, rotate −6°→0°, face-down for
  the first 90 ms then swapping to the face — that reveal is what makes it read as somebody
  playing _at_ you. Local play `slot → discard`, 170 ms, fired **optimistically on tap at
  0 ms**: this is the only way a client gets responsiveness at 40 ms RTT, and it is safe
  precisely because the overlay owns nothing — a rejected move needs `clone.cancel()` and the
  existing refusal callout, not a rollback.
- **Acceptance:** total choreography for one beat ≤ 350 ms; input never gated; a state update
  mid-flight never rolls anything back; with WAAPI absent the table renders exactly as today.
- **Tests:** component — the overlay mounts, and with no WAAPI produces no DOM change. Unit —
  anchor rect maths and the overlay-local conversion as pure functions.

### T24 — draw flight

- **Files:** `src/features/game/ui/choreograph.ts`, `src/features/game/ui/components/FlightLayer.tsx`
- **Change:** `pile:draw → hand` for me, `pile:draw → seat:<id>` for everyone else, face-down
  throughout, 200 ms, 45 ms stagger capped at **4 clones** so a ten-card penalty flies four
  cards rather than ten.
- **Acceptance:** the cap holds at every penalty size; my own draw lands in the hand, not on my
  seat.
- **Tests:** unit — planner output for `cardDrawn` at counts 1, 3, 4, 10.

### T13 — the last card, declared and caught

- **Files:** `src/features/game/ui/choreograph.ts`, `src/features/game/ui/components/FlightLayer.tsx`
- **Change:** `lastCardDeclared` gets its own cue at the declaring seat. `lastCardCaught` carries
  `playerId`, `caughtById` and `penalty` — enough for a directed cue from catcher to caught, which
  is the social heart of the game and currently a line of text.
- **When either party is me there is no seat to anchor to** — `opponents()` filters out the local
  player, so `seat:<localPlayerId>` never resolves. The `hand` anchor stands in for my own end of
  the cue, in both directions.
- **Acceptance:** the catch reads as directional; the declaration does not; both work when I am the
  catcher, when I am the caught, and when neither is me.
- **Tests:** unit — planner output for both events across all three cases.

### T21 — the +2 run escalates

- **Files:** `src/features/game/ui/choreograph.ts`
- **Change:** `drawStacked` carries a running `total`. Step the landing cue's magnitude by it so the
  fourth +2 lands harder than the first.
- **Scope cut:** v1 also wanted "the number itself on the pile". That is a new DOM node with a
  `.piles` layout cost at 320 px, in a wave that already has seven tasks, and the pending-draw
  count is already stated in words by the action prompt (`countLabel(t, 'game.pendingDraw', n)`).
  Dropped. The escalation is the part that is motion, and the part that is testable.
- **Acceptance:** magnitude is monotonic in `total` and capped, so a long run cannot become absurd.
- **Tests:** unit — planner magnitude for totals 2, 4, 6, 12 is monotonic and bounded.

### T25 — a +3 sent back

- **Files:** `src/features/game/ui/choreograph.ts`
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
- **Where the transition actually happens:** `screen: 'over'` is not set from game state. It comes
  from `applyUpdate`'s `lobby` case (`store.ts:448`) via `screenForLobbyPhase`. The host's
  `afterCommit()` calls `emitLobby()` _after_ `broadcastGameState()` and `emitEvents()`
  (`hostSession.ts:1146-1157`), so the `playerWon` beat does reliably arrive before the screen
  flips. Ordering is on our side.
- **v1's mitigation was impossible.** "The timer is cleared on unmount" cannot work in the store:
  it is a module-level zustand instance with no unmount, and `screenForLobbyPhase` runs on _every_
  lobby update including lobby→game, so a timer there must distinguish one transition from all
  others with no notion of why.
- **`sessionEpoch` is the wrong signal — reuse the pattern, not the variable.** It is incremented
  in exactly four places (`store.ts:339`, `:680`, `:749`, `:855` — accept-handoff, create, resume,
  join) and by neither `leaveRoom()` nor the `closed` case. It tracks _which session owns the
  store_, not _whether the table is still on screen_. Guarding on it would catch a leave only
  incidentally, via the `screen !== 'game'` half — and would **miss a disconnection entirely**,
  because the `closed` case sets `screen: 'home'` only when `reason === 'leftVoluntarily'`
  (`store.ts:568`) and every other reason deliberately keeps the screen so the explaining dialog can
  be drawn over it. The hold would then fire 900 ms later and route to standings for a round that
  was interrupted.
- **Corrected mechanism:** a dedicated module-level `holdToken` counter, minted when the hold starts
  and invalidated by a `clearHold()` called from `leaveRoom`, the `closed` case and the `error`
  case — plus a `clearTimeout` before every re-arm, since a guard alone makes a second write
  idempotent without enforcing a single timer.
- **Safe to defer `screen` alone:** nothing under `src/features/game/ui/` or `src/app/` reads
  `lobby.phase === 'finished'` (grepped), so letting `lobby` through immediately while holding
  `screen` changes nothing on the table — and it keeps `GameOverScreen`'s data correct the moment it
  does render.
- **The failure modes that guard exists for**, none of which v1 had identified:
  - Leave during the hold → `leaveRoom()` sets `screen: 'home'`, then 900 ms later the pending
    write sets `'over'` and strands the player on standings with no session.
  - `closed` (`store.ts:539`) sets a cleared session and sometimes `screen: 'home'` → same
    override.
  - A second lobby update inside the window — a health re-grade re-emits lobby — → two pending
    timers.
- **Acceptance:** the standings always arrive; the hold never exceeds 900 ms; leaving, closing or
  erroring during the hold routes immediately and the pending write is dropped; two lobby updates
  inside the window produce one transition.
- **Tests:** component and store-level, fake timers, **failure cases written first**: the screen
  changes after the hold; a leave during the hold wins; a close during the hold wins; a double
  lobby update does not double-fire.
- **Coverage:** re-check `store.ts` against its 78/60 floor after this task. These branches are the
  hardest in the plan to drive and they land in the one file with a ratchet.

### T28 — the recycle

- **Files:** `src/features/game/ui/choreograph.ts`, `src/features/game/ui/components/FlightLayer.tsx`
- **Change:** `drawPileRecycled` carries `count`. 420 ms: the discard clone shrinks and slides
  to the draw pile while the depth stack from T19 re-inflates.
- **Depends on T19:** the re-inflating depth stack is what the recycle animates into. Without T19
  there is nothing for it to land on.
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

- **Files:** `src/features/game/ui/choreograph.ts`, `src/lib/audio.ts`
- **Change:** seven of the **twenty-three** events get a cue: `cardPlayed` (a band-passed noise burst,
  70 ms), `cardDrawn` (the same, quieter, pitched down ~15 %, 45 ms), `turnChanged` **to me** (a
  two-note rise, 90 ms), a penalty landing on me (a descending three-note, 220 ms),
  `lastCardDeclared` (a bright ping, 120 ms), `lastCardCaught` (a distinct gotcha), `playerWon`
  (a four-note arpeggio, 600 ms).
- **Explicitly no cue** on an opponent's draw (too frequent), on any UI tap, or on an illegal
  card — a buzzer for a mistap is punishment for a UI we designed.
- **Acceptance:** the map is data, derived by the same pure planner, so it is testable without
  audio hardware.
- **Tests:** unit — the cue for each of the **23** `GameEvent` types, including the 16 that are
  deliberately silent.

### T16 — lifecycle, and iOS in particular

- **Files:** `src/lib/audio.ts`, `src/lib/lifecycle.ts`
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

- **Files:** `src/lib/audio.ts`, `src/features/game/ui/screens/GameScreen.tsx`
- **Change:** `GameScreen` already pushes one `announce()` per beat into a live region. Duck or
  gate cues so a screen-reader user is not getting speech and audio competing on every move.
- **Acceptance:** with a live-region announcement pending, cues are suppressed or attenuated.
- **Tests:** unit — a cue requested in the same beat as an announcement is attenuated.

### T27 — haptics

- **Files:** `src/lib/haptics.ts` — new, `src/features/game/ui/screens/GameScreen.tsx`
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
   the ring geometry (T14), the reduced-motion allowlist (T7), the sweep's visual direction in
   both languages (T22), and that the game screen still never scrolls with every new cue present.
   **The 320 px sweep is new work, not an extension.** `tableLayout.spec.ts` today covers 390×664
   and 780×360, and the mobile project is `devices['Pixel 5']` (393×727) — nothing runs at 320 px.
   Adding it is its own piece of work and is budgeted as such.
   And one honest limit: there is **no WebKit project** configured, so no Playwright test in this
   repo can prove anything about iOS Safari behaviour, including T2's sticky hover.
6. **New coverage floors** for `choreograph.ts` and `lib/audio.ts`, set just under where they
   land, following the ratchet convention already in `vitest.config.ts`.

---

## Exit criteria

- All 27 planned tasks done; the 2 cut tasks recorded in [Cut](#cut) with their reasons.
- `npm run verify` green: format, lint, typecheck, coverage thresholds, build.
- Playwright green on desktop and mobile projects.
- Bundle inside the ceiling: +12 kB raw JS, +4 kB raw CSS, +5 kB gzip.
- Every new cue correct in Hebrew RTL and English LTR, light and dark, at 320 px and in
  landscape.
- With `prefers-reduced-motion: reduce`, every state change still produces a visible cue — which
  is strictly better than today, where it produces none.
- **No new infinite animation.** The two that exist stay: `.spinner` (`components.css:145`) and
  the connection-health dot (`:428`), both of which are correct — one indicates work in progress,
  the other a connection in trouble. `declare-pulse` also stays as it is; see [Cut](#cut).
- No external asset, no network request, no animation or audio library.
- `npx eslint .` green with all sixteen `react-hooks` compiler rules at error level — in
  particular no `set-state-in-effect`, no ref written during render, no global read during render,
  and no floating `Animation.finished` promise.
