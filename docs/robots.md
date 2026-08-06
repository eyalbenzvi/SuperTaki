# Robot players

## Why they exist

Three problems, one mechanism:

1. **A table that cannot fill up.** Two players is a game; one is not. A robot takes a seat
   and plays, so a single player has a table — and a table of three can play four-handed.
2. **A player whose phone dies.** The room already holds their seat for five minutes and
   passes their turn for free while they are gone. That keeps the _seat_, but after three
   orbits of skipping it is no longer a game. A robot plays their hand until they are back.
3. **A player who is there but not answering.** The table can nudge them, and then it waits.
   After that, a robot plays their turns until their next tap.

## What a robot is, exactly

A **room-side policy**, and nothing else. There is no robot in the engine, none on the wire,
and none in any client.

- The engine stays pure and knows nothing about robots. Every robot move is an ordinary
  `GameCommand` through `applyCommand`, exactly like a human's.
- A robot has no privileged path. It cannot express anything a remote player cannot express:
  its decisions are typed as the wire's `GameAction`, so `skipTurn`, `leaveGame` and
  `abandonRound` are unreachable from it by construction.
- Robots live in the room because the authoritative state does. They used to live in the room
  creator's tab, which meant that player leaving took the robots with them — along with the
  game. Neither goes anywhere now.

```
src/features/game/bot/
  view.ts     what a robot may know          (the only file that may see a GameState)
  policy.ts   what it decides                (pure; no clocks, no Math.random)
  runner.ts   when it decides                (one pause at a time; the pause is injected —
                                              on the server it is a Durable Object alarm)
  names.ts    what it is called
```

## A robot cannot see your hand

This is structural, not a promise. The room holds every hand, so a policy that read
`GameState` would be reading its opponents' cards. Instead `botViewFor()` builds a `BotView`
out of the same projections a remote client is sent:

| In a `BotView`                          | Not in a `BotView`            |
| --------------------------------------- | ----------------------------- |
| `PublicGameState` — the whole table     | anybody else's cards          |
| its own hand                            | the draw pile's order         |
| which seats can answer for themselves   | who _else_ holds a +3 Breaker |
| whether an open +3 is waiting on **it** | anything else about that list |

Three tests hold the line: no card id from another hand or from the draw pile appears in a
serialised view; the same decision comes out however the _other_ hands are rearranged; and
`view.ts` is the only file in the package that imports a `GameState`.

The last two rows are the one place this is subtler than "only what a client is sent". Who
holds a +3 Breaker is private to the room, and a client infers whether _it_ may answer from its own
hand — which is right almost always, and wrong in the state that matters: a seat caught on its
last card draws four cards mid-window, and a breaker among them is not one the engine is
waiting for. So a robot is told the single bit about **its own seat** — am I being waited for —
rather than left to guess. It is a fact about itself, it says nothing about anybody else's
cards, and without it the robot would offer a move the table refuses on the one path that
unfreezes everybody.

(The human UI still guesses, and still lights up that card. It is a dead tap in a rare state,
it predates robots, and closing it properly means publishing the same self-referential bit per
recipient in the public state — worth doing, and not part of this.)

## How it plays

Legality is never re-implemented: every candidate goes through the same `isCardPlayable` the
table's own UI highlights with, so a robot cannot drift from the rules or propose a move the
room would refuse.

**Priority.** Answer an open +3 → play a card that ends the round → declare a last card →
take the turn → call somebody out. The order is deliberate: a +3 freezes every seat; the
declaration is not what wins, so pausing to shout before a winning card would only hand the
table a window to catch you; and calling somebody out is the one move a human would rather
make themselves.

**Choosing a card.** A score per playable card, best taken, ties broken from the room's
seeded stream:

| Card             | Reasoning                                                                |
| ---------------- | ------------------------------------------------------------------------ |
| +3               | strong: every other seat draws three unless somebody breaks it           |
| +2               | strong, more so against a seat that is nearly out                        |
| Stop             | strong at two players, where it is an extra turn; situational above that |
| Taki             | worth exactly what the colour behind it is long                          |
| Super Taki       | the same, in the leading colour, minus a point for spending a wild       |
| Plus             | good with something to pay it with, otherwise a turn spent going nowhere |
| number           | the baseline; prefers the colour the hand is strongest in                |
| Change Direction | mild                                                                     |
| King             | hoarded — its value is cancelling somebody else's +2 run                 |
| Change Colour    | hoarded — it is the one card that is always playable                     |
| +3 Breaker       | never played speculatively: three cards, drawn _before_ the win check    |

**Inside a Taki sequence** it spends numbers and further Takis first and keeps the punishing
card for the close, because only the closing card's effect resolves. A sequence keeps the
colour it opened in, so there is nothing else to decide: when no card of that colour is left,
it closes.

**A +2 run** is raised with another +2 if it holds one, cancelled with a King if not, and
otherwise paid in full.

## Deliberately not an oracle

- It never reasons about cards it has not seen, and does not count the discard pile to infer
  anybody's hand.
- It **can be caught** on its own last card: it declares after a human-shaped pause, not in
  the same tick, and that pause is the window in which a human can call it out. On a seat it
  is merely _covering_ it declares at once instead — those four cards would follow somebody
  else into the standings for a rule they were not there to keep.
- It calls others out slowest of all its moves, so the people at the table normally get there
  first.
- It never calls out somebody who is not there — they cannot shout, so that would be farming
  rather than catching. A seat a robot is _playing_ is fair game: the robot can shout.

## Timing

All in `network/timing.ts`, all jittered from a per-seat seeded stream.

| Constant                      | Value       | What it is                                     |
| ----------------------------- | ----------- | ---------------------------------------------- |
| `BOT_THINK_MIN_MS` … `MAX`    | 0.7–1.7 s   | before an ordinary move                        |
| `BOT_SEQUENCE_MIN_MS` … `MAX` | 0.26–0.52 s | between cards inside a Taki sequence           |
| `BOT_DECLARE_MIN_MS` … `MAX`  | 0.9–2.0 s   | before declaring its own last card             |
| `BOT_CATCH_MIN_MS` … `MAX`    | 2.2–4.0 s   | before calling somebody out                    |
| `BOT_ANSWER_MIN_MS` … `MAX`   | 0.5–1.2 s   | before answering an open +3                    |
| `BOT_STALL_MS`                | 15 s        | before the room passes a robot's own seat      |
| `STAND_IN_ABSENT_MS`          | 45 s        | absence before a robot may play a human's seat |
| `STAND_IN_IDLE_MS`            | 90 s        | silence, while present, before the same        |

`BOT_STALL_MS` is the one that is not about pacing. A robot cannot be absent, so no grace,
hold or vacate would ever rescue a table stuck on one — a suspended tab, a throttled timer or
a bug in the driver would stop the round with nothing on screen to explain it. Past the
deadline the room passes the seat itself, and logs that it had to.

## Standing in for a human

`standInEnabled` is a table setting, on by default, visible to every player in the lobby
snapshot and changeable by the seat holding the lobby buttons. When it is off, absence behaves exactly as it did before
robots existed.

A stand-in is **layered on top of** the free skip, never in place of it:

| Time since the seat went quiet | What happens                                           |
| ------------------------------ | ------------------------------------------------------ |
| 0–12 s                         | nothing; they may be back in a second                  |
| 12 s onwards                   | their turn is passed, free, as it always was           |
| 45 s onwards                   | a robot plays the seat — if the table allows it        |
| any moment they speak          | the seat is theirs again, before their move is applied |

The last row is the whole design. A stand-in changes nothing else about the seat: not the
credential, not the resume token, not the name, not the standings. It is a favour the table
does somebody, and it ends the instant it is not needed.

Never stood in for:

- a seat whose owner **said goodbye** — that was a decision, and playing the hand of somebody
  who has left is not a favour;
- a seat that is **visibly trying to come back** (a rejoin attempt in the last 20 s);
- a seat that has **left the round**;
- a seat the table has already **stopped a robot on**, for the kind of cover it stopped: a
  refusal about somebody's silence says nothing about what should happen when their phone
  actually dies, and it is spent as soon as they say anything;
- a seat that is **here and answering**: "let a robot play" needs the table to have
  actually been waiting on that player, or one mis-tap takes a hand off somebody mid-turn;
- anybody, while the table is **paused**.

The table keeps both ways out while a robot is playing: **stop the robot**, which is honoured
rather than undone by the next heartbeat, and **remove from the round** — the covered seat is
deliberately not listed as a held one, so those live on the robot's own notice.

Release is keyed on `lastIntentAt` — the last thing that seat actually _asked for_ — and never
on a heartbeat. A phone in a pocket answers every probe perfectly, so keying it on the wire
would have released every stand-in five seconds after it began.

The room creator's own seat is covered too: their own tap is an intent like any other, so somebody who
puts the phone down does not stop the round, and picking it up takes the seat straight back.

## What the table sees

- A robot seat carries a robot badge in the lobby and at the table, and no connection badge —
  there is no connection to report on.
- A seat a robot is standing in for keeps its owner's name and gains a notice every player
  sees: _"a robot is playing for Noa"_. The seat-hold countdown is suppressed while it lasts,
  because the table is not waiting for anybody.
- The seat holding the lobby buttons can start a stand-in early, or stop one, from that notice.

Nothing about robot-ness is hidden, and nothing about it is inferred from a name: a human may
of course call themselves "Robot Fern", and the badge comes from the seat, not the string.

## Votes

| Vote              | A robot seat                                                               | A seat a robot is standing in for                                                        |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Play again        | always agrees — otherwise a table with one could never deal a second round | agrees, for the same reason                                                              |
| Abandon the round | not counted: stopping is a decision, and it has no view                    | not counted: nobody is answering for that seat, which is usually why the vote was called |

A new round is still dealt by a person. Robots agree so they can never block one, but nothing
starts a round on their say-so alone: a table where every seat is robot-controlled waits on the
standings until somebody taps, which is the only reading under which the standings are for
anybody. Their agreement is also never _published_ — the count on screen is a count of people,
so the one player still there is told the table is waiting for them rather than that everybody
is ready.

An open +3 has its own deadline for the same reason. While one is open the seat on turn is the
player who _played_ it, so a seat that answers every heartbeat and taps nothing would freeze
the whole table with nothing on any screen to explain it. Past `STAND_IN_IDLE_MS` a robot takes
that seat and answers — or, if the table has robots switched off, the room declines for it.

## What a robot does not need

Two things every human client has, that a robot has no use for and does not get: the
`turnToken` that catches a move computed against a table that has moved on (a robot decides
from the state it is applied against, in the same tick), and the action lock that stops a
double tap. Neither is an advantage — they exist to make a _network_ honest, and there is no
network between a robot and the state it plays against.

## Wire and storage

Three optional fields, no protocol bump — an older reader drops what it does not know and
loses a badge rather than the game:

- `lobbyPlayer.bot`, `lobbyPlayer.standIn`, `lobbySnapshot.standInEnabled`.

The room's stored record carries `bot` per seat and the table setting, so a hibernation keeps
its robots. A robot is never offered the room in a handover: there is no device behind it.

**Known limitation.** The handover snapshot is validated by the _receiving_ build. A successor
running a build without the `bot` field would strip it, and those seats would arrive as human
seats with nobody behind them — skipped each orbit until the table removes them or agrees to
stop. Same-build handovers, which is every handover after this ships, carry robots correctly.

## Not implemented, on purpose

- **No difficulty levels.** One competent policy. The seams for more are the score table and
  the injected randomness.
- **No robots added mid-round.** A round is dealt to the seats it starts with; a stand-in is
  the mid-round mechanism.
- **No client-side robots.** A robot needs the authoritative state, and that is the room's.
- **No personality, no chat.** It plays cards.
