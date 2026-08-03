# UI/UX polish pass

A second review of the finished product, this time only from the outside: what a player sees,
taps, waits for and misunderstands. Ten perspectives were applied to the running app rather
than to the code — the whole journey was driven on two simulated phones at six viewport sizes,
in both languages and both themes, with screenshots and measured layout at every step.

Findings that led to a change are marked **fixed**. Conscious trade-offs are marked
**accepted**, with the reason.

---

## 1. Senior mobile game UX designer

**Looked at:** what occupies the screen during play, what a player has to scroll for, whether
the table answers "whose turn, what do I do, what just happened".

- **fixed — The hand was below the fold.** The table was a scrolling document: opponents, turn
  banner, colour chip, direction badge, piles, hand, game log, Leave. On a 390×844 phone the
  hand sat at 615 px with the log and the Leave button under it, so the primary interaction of
  the entire product needed a scroll. The table is now a fixed-height layout (`100dvh`, no page
  scroll) in the order a player needs things: connection, other players, table, what to do now,
  hand. Only the table region gives way when the viewport is short. Verified at 320×568 through
  1280×900 and in landscape: the game screen never scrolls at any of them.
- **fixed — Preferences dominated the chrome.** Language and theme were two segmented controls
  pinned to the top of every screen; on a phone they wrapped onto two rows and cost about a
  fifth of the viewport, competing with the table for attention on every frame of play. They
  are set-once preferences and now live behind one control, with the room code beside them for
  the moment a friend cannot get in.
- **fixed — The wordmark was on screen twice** on the landing page, once in the bar and once in
  the hero.
- **fixed — No "what do I do now".** The screen could stack four notices at once — a pending
  draw, a pending Plus, a free play, "no legal card" — all in the same flat blue box, leaving
  the player to work out which one was addressed to them. There is now exactly one prompt, in
  strict priority order, with the buttons for acting on it, directly above the hand.
- **fixed — The game log cost a fifth of the table** to show four lines of history nobody reads
  mid-turn. The newest line stays on screen as a one-line ticker; the history is one press away.

## 2. Product designer, multiplayer and social flows

**Looked at:** getting from "let's play" to a dealt table with five other people's phones.

- **fixed — The lobby buried its own purpose.** Its whole job is to get other people into the
  room, and the room code was a small right-aligned value in a label row while three wrapped
  lines of raw invite URL took the space below it. The code is now the largest thing on the
  screen; Copy code, Copy link and Share are equal-weight actions; the URL is behind a
  disclosure for the rare case someone wants to read it.
- **fixed — Nothing told a first-time player what this is.** Someone arriving on the landing
  page cannot choose between "create" and "join" without knowing that one person opens a room
  and everyone else comes to it. Three lines now say so.
- **fixed — No empty state.** A host alone in a room saw "1 of 4 players" and a dead Start
  button. They are now told to share the code, and told when the table is ready.
- **fixed — Host-only controls outranked the host's actual job.** The maximum-players panel sat
  between the roster and Start. It is a disclosure now, and Start is in a sticky action bar.
- **fixed — "Back to home" on the end-of-round screen closed the room** for every other player
  with no warning, taking the rematch with it. It goes through the same confirmation as any
  other exit.

## 3. UI visual designer / design-system specialist

**Looked at:** whether the app was built from a system or from one-off styling.

- **fixed — There was no type scale, no z-index scale and no motion vocabulary.** Font sizes
  were written inline per component (`0.75rem`, `0.825rem`, `0.85rem`, `0.925rem`, `1.05rem`,
  `1.15rem`), stacking used four magic numbers (20, 50, 60, 100), and motion was two
  durations with no easing. All three are token scales now, and nothing outside `tokens.css`
  invents a value.
- **fixed — Variants were composed by accident.** The lobby's remove control was
  `btn--danger btn--ghost`, two variants that contradict each other; the result was a red ✕
  glyph with no button affordance at all. There is now one `Button` with explicit variants and
  sizes, and one `Callout`, `Badge` and `Field` — about thirty hand-assembled `className`
  strings replaced.
- **fixed — Emoji-as-icon.** The remove control was a bare `✕` character. There is now a drawn
  icon set on one grid at one stroke weight, and every icon-only control carries an accessible
  name.
- **fixed — Disclosures did not look interactive.** `display: flex` on a `<summary>` removes the
  browser's marker, so both disclosures read as plain headings. They carry an explicit chevron.
- **fixed — Dead CSS and dead strings.** The stylesheet still carried rules for the rules page
  removed in the rebrand, plus `.max-players`, `.pile__stack` and `.page--wide`; the
  dictionaries carried seven keys nothing referenced. Removed, or put to use.

## 4. Mobile interaction and touch-target specialist

**Looked at:** every target under a thumb, and what happens when the thumb lands slightly off.

- **fixed — A fanned hand could play the wrong card.** With more than a handful of cards they
  overlap, and a tap lands on the middle of a card; at the original fixed offset the neighbour
  lapping over it owned that middle, so a confident tap played a different card —
  irreversibly, in front of everyone. The overlap is now solved from the row's real width and
  floored at just over half a card, so every card owns its own centre; past that floor the row
  scrolls instead. Confirmed by driving a 16-card hand.
- **fixed — Segmented options were 38 px tall** against a 44 px target token.
- **fixed — No safe-area handling at all.** The viewport is `viewport-fit=cover`, so content ran
  under the notch and the home indicator. Every edge-anchored surface — bar, page, sheet, toast,
  action bar, hand — now adds the inset.
- **fixed — 300 ms tap delay and double-tap zoom** on every control (`touch-action`).
- **fixed — Inputs at 15 px zoomed the page on focus in mobile Safari**, leaving the player
  pinched into a form they were filling in. Inputs are at least 16 px.
- **fixed — Pull-to-refresh could reload the page mid-game** when a swipe on the hand or the log
  reached its end. Overscroll is contained.

## 5. Accessibility, WCAG-oriented

**Looked at:** contrast, colour as the only channel, keyboard, live regions, focus.

- **fixed — White on the green colour-picker option was 3.8:1**, below 4.5:1 for normal text.
  Solid-fill suit tokens were added for the case where a suit colour carries text; the green is
  now 5.5:1. Red, blue and the yellow/dark pairing were measured and already pass (4.8:1,
  6.9:1, 11.6:1).
- **fixed — An unplayable card was `disabled`,** which cannot be focused: a keyboard or
  screen-reader player could not read their own hand, and a tap did nothing at all. Cards are
  `aria-disabled` now, stay reachable, and a press explains why the card cannot be played.
- **fixed — Twelve cards were twelve tab stops.** The hand is one keyboard widget: a single tab
  stop, arrow keys along the fan in the reading direction, Home and End to the ends.
- **fixed — Arrow keys moved the wrong way in Hebrew.** The segmented control mapped ArrowRight
  to "next" regardless of writing direction. It follows the direction, and gained Up/Down and
  Home/End.
- **fixed — Two live regions competed.** The turn banner was `aria-live` and the log list was
  `aria-live`, so a screen reader read a scrolling history and then the turn again. There is one
  polite region carrying one message — what just happened, and who is up — and rejected moves
  stay an `alert`, because a move that did not happen must interrupt.
- **fixed — A screen change was silent** for a screen-reader user; the new screen is announced
  without stealing focus from a player mid-gesture.
- **fixed — Turn ownership was colour-and-position only.** A seat on turn now carries a ring, a
  caret, and the banner naming them in words. Connection trouble spells itself out instead of
  relying on a coloured dot. An opponent's last card is called out in text.
- **fixed — 12 px interface text** in badges, pile labels and health chips. The floor is 13 px
  for counters and 14 px for anything read as a sentence.
- **fixed — The winner was marked by a tint and bold** in the standings; it is also named.
- **accepted — Cards still carry no printed word.** Every symbol is a distinct shape and every
  card has an accessible name; the printed deck has no words either, and adding them would
  break the product's identity.

## 6. Front-end performance engineer

**Looked at:** what re-renders, what repaints, what blocks.

- **fixed — Every store change rebuilt every card.** The table subscribed to the whole store, so
  a heartbeat re-grading a connection, a toast opening or a preference changing re-rendered it —
  and each card face builds five extruded symbols out of polygon geometry at render time, so a
  twelve-card hand is sixty geometry builds per render. The table now subscribes to six fields,
  and card faces and glyphs are memoised on what the drawing actually depends on.
- **fixed — `background-attachment: fixed`** forced a full repaint per scroll frame in mobile
  Safari. The gradient is its own fixed layer.
- **accepted — PeerJS is still in the initial bundle** (479 kB raw, 141 kB gzipped). Deferring it
  behind create/join would mean making the transport factory asynchronous, which is the one
  layer this pass was asked to leave alone. Recorded as a limitation instead.

## 7. Game UX and game-feedback specialist

**Looked at:** whether cause and effect are visible.

- **fixed — A played card appeared without arriving.** The top of the discard pile is the only
  place the table records what just happened, and it changed silently. The new card now lands,
  with the animation off under `prefers-reduced-motion`, where the log line carries it instead.
- **fixed — The active colour was nowhere near the card it applies to.** After a Change Colour
  the top card and the colour in force disagree — exactly when a player needs both facts at
  once. The colour is drawn as a rail around the discard pile, with its name beside it.
- **fixed — Turn direction was text nobody reads** ("Play order: forwards") and it was
  absolutely positioned over the discard pile at some widths. It is an arrow with its label,
  beside the turn banner.
- **fixed — No press feedback on a card.** Every card, legal or not, answers a press.
- **fixed — The hand reshuffled itself visually on every draw**, because it was shown in deal
  order. It is grouped by colour and ordered within each group, which is also how a hand of
  fourteen becomes readable at a glance.

## 8. QA engineer: mobile browsers, screen sizes, unreliable connections

**Looked at:** the whole journey at six viewports, in landscape, with long names, and with a
player dropping out. Two real bugs surfaced.

- **fixed (bug) — A fragment jump threw the player off their screen.** The skip link navigates
  to `#main`, which fires `popstate`; the new back-button handling read that as a back press and
  sent the player home — or, in a room, opened the leave dialog on top of a live game. History
  entries now carry their own depth and only a genuine step backwards is treated as one. Found
  by the component suite, not by reading the code.
- **fixed (bug) — A fixed-position sheet inside the top bar was clipped.** The bar carries a
  `backdrop-filter`, which makes it a containing block, so the settings sheet was positioned
  against the bar instead of the viewport and was unreachable. Found by driving a real browser.
- **fixed — Landscape on a phone was unusable.** About 350 px of height with a layout designed
  for 844. Cards come down a size, the chrome tightens, and the table keeps its own scroll while
  the prompt and the hand stay put.
- **fixed — Long names.** A 28-character name truncates in a seat, a roster row and a standings
  row without pushing anything off screen; the full name is in the `title`.
- **fixed — No horizontal scrolling anywhere**, verified programmatically at 320, 390, 430, 820,
  844×390 and 1280 across home, create, lobby, game and end-of-round.
- **fixed — An offline device blamed the room.** `navigator.onLine` is watched, and a device with
  no network is told to check its own network and that its seat is being held.
- **verified — No console errors, warnings or unhandled rejections** in any of the scripted runs.

## 9. UX copywriter, localisation-aware

**Looked at:** every user-facing string, in both languages.

- **fixed (bug) — An opponent's seat said "Your turn".** The current-turn badge reused the
  local-player string, so somebody else's seat claimed to be yours. It reads "Playing now".
- **fixed (bug) — A hand card said "You can only draw on your own turn".** The out-of-turn
  reason for the _draw pile_ was passed to the hand as its explanation. Cards say "Wait for your
  turn".
- **fixed — "1 cards".** Every counted phrase was a single template with `{count}`. There is now
  a plural pair per phrase, selected by one helper, with a test that asserts both halves exist
  in both languages and that the singular form never interpolates the number — because Hebrew
  spells it ("קלף אחד").
- **fixed — Two keys held the same string** (`game.handCount`, `game.cardsLeft`); the discard
  pile was labelled "Top of the discard pile" in one place and the colour indicator repeated the
  word "colour" beside a swatch already labelled colour.
- **fixed — Seven dead strings** and two duplicate hint strings removed or put to use.

## 10. Cognitive load and error prevention

**Looked at:** what a player can do by accident, and what they cannot undo.

- **fixed — A double tap played two cards.** Nothing debounced a submitted move: the host
  rejects the duplicate, so the player who legitimately played a card was told "that card is not
  in your hand". A move now locks the table until the answer lands — released by new state, a new
  hand or a rejection, with a deadline so a dropped packet can never freeze a hand.
- **fixed — Removing a player was one tap** on a control beside their name in a list, with no
  confirmation and nothing they could do about it. It asks first.
- **fixed — Nothing guarded a refresh mid-game.** For a host that closes the room outright. The
  browser's own confirmation is used for exactly that window.
- **fixed — Back exited the app** on Android instead of moving inside it, and could drop a player
  out of a live room.
- **fixed — A render error left a blank page**, the worst dead end there is, because nothing is
  left to press. An error boundary keeps the player on a screen that says what happened.
- **accepted — No undo.** The host owns the only authoritative state and a move is broadcast the
  moment it is accepted; a client-side undo would desynchronise the table. Irreversible actions
  are instead protected before the fact — the action lock, the confirmations, and a fan geometry
  where a card owns its own centre.

---

## Summary

| Perspective                | Fixed  | Accepted |
| -------------------------- | ------ | -------- |
| Mobile game UX             | 5      | 0        |
| Multiplayer product design | 5      | 0        |
| Visual design system       | 5      | 0        |
| Touch interaction          | 6      | 0        |
| Accessibility              | 9      | 1        |
| Performance                | 2      | 1        |
| Game feedback              | 5      | 0        |
| QA across devices          | 7      | 0        |
| Copy and localisation      | 5      | 0        |
| Error prevention           | 5      | 1        |
| **Total**                  | **54** | **3**    |

Four of these were outright bugs, and every one of them was found by driving the product rather
than by reading it: an opponent's seat claiming to be your turn, a hand card explaining the draw
pile's rules, a settings sheet made unreachable by a `backdrop-filter` two elements above it, and
a skip link that navigated the player off their own screen.
