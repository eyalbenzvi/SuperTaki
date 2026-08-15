# Easements

## The problem

A table with a six-year-old and a twelve-year-old at it is not a fair game, and it cannot be
made into one by playing fairly. Every ordinary answer is worse than the problem: bending a
rule for one player turns every round into an argument about the bending, handicapping the
older child is a punishment for being older, and letting somebody win on purpose is obvious
to the person it is done for — which is the one outcome that spoils the evening completely.

So the table bends **luck** instead, and says nothing to anybody.

## What it is

The seat holding the lobby buttons can mark some of the other players and choose one strength
for the whole table. From the next deal, marked seats get slightly luckier cards and a table
that is slightly slower to punish them.

Three constraints define the whole design:

1. **No rule moves.** No penalty is smaller, no card is legal that was not, and no number
   anybody can count is different. Everything here changes _which card comes off a shuffled
   pile_, never what may be done with it.
2. **Nobody is told.** Not the other players, and not the marked child either. A concession
   that is announced is not a concession, it is a label.
3. **Never everybody.** The seat holding the buttons is not eligible, so somebody is always
   playing the ordinary game. A lean the whole table shares is not a lean.

## The dial

One setting for the room — off, light, medium, strong — and a list of seats. The engine sees
only a weight per seat (`0`–`3`); it has no idea the two are related. `assist.ts` is the whole
of it and every function in it obeys three properties, all of which are tested:

- **Cards are conserved.** Every bias is a permutation or a choice of index inside a pile the
  caller already had.
- **No new randomness.** Total functions of state the engine already holds, so a round still
  replays exactly and turning the feature on does not advance the shuffle by a single step.
- **Nought is nothing.** With no weight on any seat, every function returns what the caller
  would have done anyway. An unmarked table is not merely fair — it is byte-for-byte the game
  as it was before any of this existed.

## The six methods

| #   | Method               | Where                                 | What it does                                                                                                                                |
| --- | -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The deal**         | `createGame`, via `assignHands`       | Hands are dealt exactly as always, then _assigned_: marked seats take the strongest. A permutation, nothing more.                           |
| 2   | **The draw**         | `drawCards`, via `chooseDrawIndex`    | A marked seat takes the best of the top 2–5 cards instead of the top one. Reaches penalty draws too.                                        |
| 3   | **The recycle**      | `recycleDrawPile`, `frontLoadForDraw` | When a marked seat's draw empties the pile, the reshuffle puts its best few cards near the top.                                             |
| 4   | **The robots**       | `bot/policy.ts`, `bot/runner.ts`      | Won't call a marked seat out, won't aim +2/+3/Stop at one, sometimes plays second-best, and leaves a catchable window on its own last card. |
| 5   | **The opening**      | `createGame`, `biasedStartIndex`      | The opening card prefers the marked hand's colour; odd rounds open on a marked seat.                                                        |
| 6   | **The catch window** | `gameRoom.withinLastCardGrace`        | A marked seat keeps its "last card!" head start for a second or two longer, and waits for nothing when catching.                            |

Method 1 is the largest single effect and the least detectable — it is literally a deal that a
differently-seeded evening would have produced by itself. Method 2 carries the most weight
over a round, because nobody can see the order of a face-down pile. Method 4 is invisible for
a different reason: bad play looks like bad play.

### Why method 4 is not "the robot plays badly"

It takes the _second_-best card, not a bad one, so the table stays worth beating. And it gives
back something a robot had taken: `BOT_DECLARE_*` is 0–100 ms, which makes a robot's last card
uncatchable in practice. At a leaning table that becomes `BOT_SOFT_DECLARE_*` — 0.9–2 s — so
catching the robot out becomes a thing a small child can actually do, unaided, on their own
reflexes. It is the only moment in this game they can win without a card going their way.

### The one method another player can meet

Method 6 is the exception to "nobody can notice": another player taps _never declared!_ and
the room answers that there is nobody to catch. What makes it survivable is that this is
already the commonest outcome of tapping that button — a target who shouted a moment earlier
produces the identical refusal, and has since long before any of this existed. It reads as
having been beaten to it, because most of the time that is what it is. The extension is kept
to a second or two for exactly this reason.

## Where the secret lives

| Layer                      | What it holds                    | Who can see it                                   |
| -------------------------- | -------------------------------- | ------------------------------------------------ |
| `RoomRecord.assist`        | the level and the list           | the room's own storage                           |
| `GameState.assist`         | weights, baked in at the deal    | the room; no projection in `views.ts`            |
| `LobbySnapshot`            | **nothing**                      | broadcast to everybody — and deliberately silent |
| `assistState` message      | the list, plus one number        | the list to the creator's socket only            |
| `assistState.catchDelayMs` | how long _your own_ button waits | each player, about themselves, naming nobody     |

There is no code path that puts the list in a message more than one player receives, and a
worker test asserts on the raw frames rather than the model: no other player's socket ever
carries the string `"settings"` or `"level"`.

Two limits worth stating plainly:

- The powers follow `creatorPlayerId`. If the creator leaves the room, the buttons — and the
  list — pass to the lowest-numbered remaining seat, which could be a child. That is inherent
  to how every lobby power works here, not specific to this one.
- A player who opens the developer tools on **their own phone** can see their own
  `catchDelayMs`. It is a number about themselves; it names nobody and reveals no list.

## Why it is fixed at the deal

`GameState.assist` is a property of the round, exactly as `mode` is, and for the same reason: a
round is dealt the way it is dealt. Reading it off the room on every command would mean a hand
dealt generously could be drawn into meanly halfway through, at the moment somebody happened to
open the settings — and a replayed round would depend on something outside the state it
replays from. The setting reaches the _next_ deal, never the one in play.

## What was deliberately not built

**Smaller penalties.** Drawing three instead of four on a catch, waiving a +2, granting an
extra turn. Every one of these is a rule change rather than a bend in the luck, and every one
of them is _countable_: `cardDrawn` carries its count, it is broadcast to the whole table and
the game log renders it. A child who counts cards finds it in the first round.

**Deliberately bad luck for the unmarked.** The mechanism is one-sided on purpose. The deal is
zero-sum, so a marked seat taking the best hand already means somebody else does not get it —
but feeding an unmarked player actively poor draws is a different thing, and the unmarked
player at this table is usually also a child.

**Client-side help.** Highlighting the best card for one seat, a louder "last card!" reminder,
a longer leash before a robot stands in. None of it is luck, all of it is discoverable from
the device it runs on, and it was cut for both reasons.
