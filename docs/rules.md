# Rules of Super Taki / חוקי סופר טאקי

These are the **exact** rules the engine implements. Where editions of Taki disagree, one
interpretation was chosen, documented here, and covered by tests. The app itself has no
rules page: this file is the specification.

Every rule below corresponds to at least one unit test in `tests/unit/engine/`.

---

## English

### The deck — 116 cards

| Cards                                       | Count     | Total   |
| ------------------------------------------- | --------- | ------- |
| Numbers 1, 3–9, four colours, two of each   | 8 × 4 × 2 | 64      |
| Stop, four colours, two of each             | 4 × 2     | 8       |
| Plus, four colours, two of each             | 4 × 2     | 8       |
| +2, four colours, two of each               | 4 × 2     | 8       |
| Change Direction, four colours, two of each | 4 × 2     | 8       |
| Taki, four colours, two of each             | 4 × 2     | 8       |
| Change Colour (no colour)                   | —         | 4       |
| Super Taki (no colour)                      | —         | 2       |
| King (no colour)                            | —         | 2       |
| +3 (no colour)                              | —         | 2       |
| +3 Breaker (no colour)                      | —         | 2       |
| **Deck total**                              |           | **116** |

Colours: **red, blue, green, yellow**.

**There is no plain 2.** In Taki the only card carrying a 2 is the +2, printed as a snapped
`2` with a plus beside it, so the numbers run 1, 3, 4, 5, 6, 7, 8, 9. A separate number 2
was a card the physical deck does not contain, and on screen it read as a +2 that had lost
its plus.

**Only Change Colour repaints the table.** Since the King joined the deck, the other
colourless cards — Super Taki, King, +3 and +3 Breaker — keep whatever colour is already
leading. The engine enforces it: playing any of them with a chosen colour is rejected with
`colorNotAllowed`.

### Setup

- 2 to 6 players. Seats keep the order in which players joined, and that order is visible
  to everyone.
- The deck is shuffled with a seeded PRNG, so a given seed always deals the same game.
- Each player is dealt **8 cards**.
- The opening card is the **first number card** taken from the top of the shuffled deck.
  Any special card met on the way is moved to the **bottom** of the draw pile, so no card
  is wasted and the first turn is never ambiguous.
- The player in seat 1 (the host) starts. Play begins in the "forwards" direction.

### A turn

On your turn you do exactly one of:

1. **Play a legal card**, or
2. **Draw from the draw pile** — one card normally, or the whole outstanding +2 run. This
   is always open to you, whatever you are holding; the one thing that closes it is a Taki
   sequence of your own, which you have to close first.

A card is legal when any of these holds:

- it matches the **current colour**, or
- it matches the **symbol** of the top card — the same number value, or the same action
  kind (Stop on Stop, +2 on +2, Plus on Plus, and so on), or
- it is a **colourless card** (Change Colour, Super Taki, King, +3), which is legal on any top
  card. The one thing that narrows this is an open +2 run: while cards are owed, **only a +2 or
  a King is legal**, colourless or not.

A **+3 Breaker is legal as an ordinary play, and it is expensive**: with no +3 to break, the
three cards it would have sent back are drawn by the player who spent it. See below.

Note the consequence of symbol matching: a Blue Stop is legal on a Red Stop, because the
_symbols_ match even though the colours do not. The same is what lets any +2 answer any +2.

**A Super Taki is a Taki for the purpose of matching.** It prints TAKI and it has no colour
of its own, so a Taki of any colour is legal on top of one — the symbols match — and a Taki
of any colour may equally be answered by the Super Taki. Anything else would leave a table
showing TAKI refusing a hand holding TAKI.

**Drawing ends your turn.** A card you just drew may not be played in the same turn, even
if it is legal. (Chosen for clarity; some variants allow it.)

**Playing your last card wins the round**, declared or not. What an undeclared last card
risks is being caught before you get to play it — see "Last card" below.

**Except a Plus.** A Plus owes one more card, and a hand you have just emptied has none to
give — so a Plus played as your last card does not win: you take one card from the draw
pile and the turn passes. It is the one card in the deck that cannot end a round.

### Special cards

| Card                 | Effect                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stop**             | The next player loses their turn. With two players the turn comes straight back to you.                                                                                                                       |
| **Plus**             | You owe one more card: play it, or take one from the draw pile instead. A second Plus repeats the obligation. Played as your last card it does not win — you take the card you owe.                           |
| **+2**               | The next player owes two cards — unless they add a +2 of their own, which raises the run by two and passes it on. See below.                                                                                  |
| **Change Direction** | The play order reverses. With two players the turn still passes to your opponent.                                                                                                                             |
| **Change Colour**    | Playable on anything. You choose the next colour, and your turn ends.                                                                                                                                         |
| **Taki**             | Opens a sequence in that card's colour — see below.                                                                                                                                                           |
| **Super Taki**       | Playable on anything. Opens a sequence in the colour already leading.                                                                                                                                         |
| **King**             | Playable on any top card, **including** as an answer to an open +2 run, which it cancels outright. Gives you a free turn with no matching.                                                                    |
| **+3**               | Every other player draws three cards — unless somebody breaks it. See below.                                                                                                                                  |
| **+3 Breaker**       | Playable **out of turn** in answer to a +3: the player who played the +3 draws three instead, and nobody else draws. Played with no +3 open, it is an ordinary colourless card and its owner draws the three. |

A Plus obligation is an obligation to **act**, not to play: you may pay it from the draw
pile even holding a legal card, and drawing ends your turn exactly as it does on any other
turn. The card you play instead follows normal matching rules — it does not have to be the
same colour as the Plus. The same is true of the free turn a King grants, which is the same
flag: you may decline it by drawing. So the draw pile is open on every turn of yours but
one, and the exception is an open Taki sequence.

### "Last card"

A player down to a single card must declare it. This is the one rule in Taki that is a
_shout_ rather than a move, and it is implemented as one — including the part where the
other players are the ones who enforce it.

1. **Who may declare, and when.** Anybody holding **exactly one card**, at any moment,
   in or out of turn — even while a +3 has the rest of the table frozen. Declaring is not
   playing: it does not touch the turn, the colour or the pile.
2. **It goes with the card, not with the player.** The moment your hand stops being one
   card — you draw, you take a +2 run, a +3 lands on you — the declaration lapses. Coming
   back down to one card needs a fresh one.
3. **One declaration per card.** A second is rejected with `alreadyDeclared`; declaring on
   any other hand size is rejected with `nothingToDeclare`.
4. **The declaration is not what wins the round.** Putting your last card down is. A player
   who never declared still wins by playing it, exactly as one who did.
5. **What silence costs is being caught.** While a player sits on a single undeclared card,
   **any other player** may call it out, in or out of turn, and the silent player draws
   **four cards**. Drawing them closes the window by itself, because the hand is no longer a
   single card. Calling out a player who declared, who is not on one card, or yourself, is
   rejected with `nothingToCatch`. **Every seat is told who called it**, in a banner as well
   as in the log: from three players up, "somebody drew four" does not say whose call it was.
6. **The first instant belongs to the player.** From the moment a hand comes down to one
   card, nobody may call that player out for **100 ms**. It exists because the two halves of
   the moment are not simultaneous on a screen the way they are at a table: the play has to
   reach the host, the new hand has to come back, and only then does a declare button appear
   where nothing was — while every opponent's catch button is already on screen, already
   under a thumb. 30 ms sat here first, which was under a round trip and handed the
   difference to whoever happened to be watching; 300 ms sat here next, which covered more of
   the reach than a window settling an ordering has any business covering. A round trip is
   the measure, and the reach itself is answered by rule 8 below. It is the host's clock that
   measures it, and a catch made inside the window is refused with `nothingToCatch` — there
   is nothing to catch _yet_. The button does not appear on the other players' screens until
   it has passed. Coming back down to one card later buys a fresh window, exactly as it needs
   a fresh declaration.
7. **It is public.** Who has declared is part of the table state everyone sees, the same
   way a shout at a real table is heard by everyone. That is what makes catching possible at
   all, and it is why every seat on one card shows either "declared" or a button to call it.
8. **You may shout with the card.** A card that asks for a colour — Change Colour — puts a
   dialog between the play and the declaration, so the head start above is spent choosing a
   colour rather than reaching for the button. When such a card would leave you on one, the
   colour dialog offers the shout beside the four colours: arm it, pick a colour, and the
   play and the declaration are one move, applied together, with no instant in between for
   anyone to catch. It is **off by default** — the rule being enforced is remembering, and a
   box that remembers for you is a different game — and the host honours it only when the
   play really does leave exactly one card in hand. A play that empties the hand wins instead,
   and a +3 Breaker spent on nothing draws its three cards first, so neither declares.

### +2 runs

- Playing a **+2** sets the outstanding penalty to two cards and passes the turn.
- The player to move may answer with **another +2 of any colour**, which raises the run to
  four, then six, and so on. The colour of the run follows the last +2 played.
- **A King cancels a run.** Two cards are legal while a run is open, and they do opposite
  things: a +2 raises the run and passes it on, a King wipes it. The whole run goes — two
  cards or ten — its owner draws none of it, and they carry straight on into the free turn
  the King always grants. Every other card is still rejected with `mustAnswerDraw`.
- A player who will not or cannot answer **draws the whole run at once** and loses their
  turn. Drawing two is a single decision, not two separate draws.
- A +2 played **inside** a Taki sequence does nothing until the sequence closes; then, if
  it was the last card, it opens a run in the usual way.

### The King

The King buys you a turn in which nothing has to match:

1. Play it on any top card, at any point in your turn.
2. **It cancels an open +2 run.** Played while cards are owed, the whole outstanding run
   disappears — however high it was stacked — and its owner draws none of it. The
   cancellation is logged with the number of cards nobody drew.
3. The leading colour does not change, including when it cancels a run: the colour the last
   +2 set is simply left standing.
4. You then play again, and on that free turn **every card in your hand is legal** —
   colour and symbol do not apply. Playing it sets the colour as usual.
5. The free turn is declinable like any other obligation: drawing **one** card from the pile
   ends your turn. The run it cancelled is already gone, so that single card is all it costs.
6. If your hand were somehow empty you would already have won; there is no stuck state — a
   King played as your last card wins the round, run or no run.

### +3 and the +3 Breaker

The +3 is the one card that suspends the turn order.

1. A player plays a **+3**. The leading colour does not change.
2. The engine looks for players — other than the one who played it — who hold a **+3
   Breaker**. If nobody does, the +3 resolves immediately: everyone else draws three.
3. If somebody does, the table freezes. Every other command is rejected with
   `awaitingBreak`, including the +3 player's own moves.
4. Each holder either plays their breaker or declines (`passBreak`). The **first breaker
   played** ends the window: the player who played the +3 draws three, and nobody else
   draws. If every holder declines, the +3 resolves as in step 2.
5. Either way, play then continues from the seat after the +3 player.

**A breaker with nothing to break.** It is still a legal card — colourless, so playable on
anything — but the three cards go to the player who spent it, and they are drawn _before_ the
win check, so it can never be a free way out of a last card. Passing (`passBreak`) with no +3
open is still rejected with `noPlusThreeOpen`: there is nothing to decline.

**Who holds a breaker is never published.** The public table state says only that a +3 is
open and who played it; the list of players being waited for stays on the host. A client
works out whether it may answer by looking at its own hand, which it already knows.

### Taki sequences

- Playing a **Taki** card opens a sequence locked to that card's colour.
- While the sequence is open you may play **any number of further cards of that colour**,
  including other special cards and further Taki cards.
- **Colourless cards cannot enter a sequence.** Change Colour, King, +3 and the +3 Breaker
  have no colour, so the engine rejects them with `wildNotAllowedInTaki`. The Super Taki is
  the one exception, and only in the case below — it is a Taki, and every rule about a Taki
  laid on a Taki means it too.
- **An ordinary card of a different colour is rejected** with `wrongTakiColor`, even if its
  symbol matches the top card. Inside a sequence, colour is the rule.
- **A Taki laid straight onto another Taki continues the run, whatever it is printed on.**
  While every card played in the sequence is a Taki, you may lay **any** Taki on it —
  coloured or Super. A coloured one carries the run into its own colour; a Super Taki has no
  colour of its own, so it leaves the run exactly where it is. Either way the run continues,
  uninterrupted, and you go on playing cards of the sequence colour before closing as usual.
  You may do it more than once, so Red Taki → Blue Taki → Green Taki is a green sequence, and
  Red Taki → Super Taki → Blue Taki is a blue one.
- **The moment an ordinary card joins the run, the colour is settled.** After Red Taki →
  Red 3, no Taki reopens the choice — not even Red Taki → Red 3 → Red Taki → Yellow Taki,
  where a Taki is on top with nothing on it. What matters is the run, not the top card.
- A Taki played on a Taki **when no sequence is open** is an ordinary symbol match and opens
  a sequence of your own, in your card's colour.
- **You cannot draw while a sequence is open.** Close it first (`cannotDrawDuringTaki`).
- Close the sequence with the explicit **Close Taki** button. You may close it at any time,
  and you must close it when you have no more cards of that colour.
- **When the sequence closes, only the effect of the last card played applies.** Cards
  played earlier in the sequence have no effect at all. So:
  - last card a number, or a Taki card → the turn passes normally;
  - last card **Stop** → the next player is skipped;
  - last card **Plus** → you must play one more card (outside the sequence, normal
    matching);
  - last card **+2** → a run of two opens against the next player;
  - last card **Change Direction** → the order reverses, then the turn passes.
- Emptying your hand during a sequence wins immediately — unless the card that emptied it
  was a **Plus**, which owes one more card. Then the sequence closes, you take a card from
  the pile for the Plus, and the turn passes.

### Super Taki

Super Taki is a colourless Taki that takes the colour already in play:

1. Play it on anything.
2. A sequence opens in the **current colour**. You are not asked to choose, and asking is
   rejected with `colorNotAllowed`.
3. From there it behaves exactly like a Taki sequence: same-colour cards only, no
   colourless cards, explicit close, last-card effect on closing.
4. If you close the sequence with the Super Taki still the top card, the turn simply passes
   and the colour is unchanged.
5. It matches as a Taki. Once it is the top card, a coloured Taki from anybody's hand is a
   plain symbol match on it, sequence closed — the next player is not made to hunt for the
   leading colour just because the card that set it happens to be colourless.
6. And the same in reverse, inside a sequence: while the run is nothing but Takis, a Super
   Taki may be laid on it. A coloured Taki is legal on top of a Super Taki, so a Super Taki
   has to be legal on top of a Taki, or the rule would read in one direction only. It carries
   nothing — the run stays in the colour it was already in.

### Effect order when a card is played

1. The card leaves your hand and goes on top of the discard pile.
2. The current colour becomes the card's colour, your chosen colour for a Change Colour, or
   stays as it was for any other colourless card.
3. **Win check:** hand empty → the round ends, you win, nothing else resolves. The one
   exception is a **Plus**: the hand still owes a card, so one is drawn from the pile, any
   sequence of yours closes, and the turn passes instead of the round ending.
4. If the card was a +3 Breaker → the open +3 settles and the turn moves on.
5. If a sequence is open → the card only joins the sequence; no effect resolves yet.
6. Otherwise, if the card is a Taki or Super Taki → a sequence opens; the turn stays with
   you.
7. Otherwise, the card's effect resolves (skip / extra card / run / reverse / cancel /
   pass).

### Running out of cards to draw

When the draw pile is empty and someone must draw, every card in the discard pile **except
the visible top card** is shuffled back into the draw pile, using the same seeded PRNG. The
top card stays face up so the colour and symbol in play are preserved, and no card is ever
lost — a test asserts the full set of card ids is conserved.

If there is genuinely nothing left to draw (an empty draw pile and only one discard), the
turn simply passes. No player is ever stuck.

### Game modes

The mode is chosen when the table is set up — on the create-a-table screen, and still
changeable in the room settings until the cards are dealt. It is fixed for the round the
moment the deal happens: a round is won the way it was dealt, whatever the table's setting
says afterwards.

| Mode                     | An empty hand means                                                   |
| ------------------------ | --------------------------------------------------------------------- |
| **Classic**              | You have won the round.                                               |
| **Stairs** (טאקי מדרגות) | You have finished one hand of eight, and are dealt the next one down. |

**Stairs**, in full:

- The round opens exactly like a classic one: **8 cards** each.
- Empty your hand and you are immediately dealt a fresh one, **one card smaller**: 8, then
  7, 6, 5, 4, 3, 2, and finally 1.
- Emptying the hand of **one** — the eighth hand you have finished — wins the round. A Plus
  cannot be the card that does it: as in a classic round it owes one more card, so you take
  one from the pile and stay on the last step.
- The new cards come off the draw pile, which recycles the discard pile as usual, so a
  staircase is roughly thirty-six cards a player rather than eight.
- Nothing else changes. The step happens in the middle of the turn that caused it, and the
  rest of that turn plays out exactly as it would have: a Plus still gives you another
  card to play, a Stop still skips the next seat, and a Taki sequence you had open is
  still open — you carry on with the hand you have just been dealt. A Plus is only refused
  on the step that would have **won**: everywhere else the new hand is what pays for it.
- One consequence worth stating: the step down to the final hand of one puts you on a
  single card, so **"last card" applies to it like any other single card** — declare it or
  be caught. A declaration made for the card you have just played does _not_ carry over;
  the new hand needs its own shout.
- The standings for a stairs round are ordered by **hands finished** first and cards left
  second, because a player one step from the end may be holding more cards than somebody
  who has finished nothing.

### End of the round

- The round is won by emptying your hand — in **stairs**, by emptying the eighth of them —
  with any card but a Plus, which owes one more and is answered from the draw pile.
- The final table lists everyone by remaining cards, fewest first; ties share a place. A
  stairs round adds a column for how far down the staircase each player got, and ranks by
  that first.
- **Score.** The room keeps a running total of **rounds won** — wins only, no points for
  the cards anybody was left holding — and shows it beside the standings at the end of
  every round. It belongs to the room: it starts at nought when the room is opened, a seat
  that leaves for good takes its score with it, and closing the room clears it entirely.
- **Play again** starts a new round when **every connected player agrees**. Players who
  never reconnected are dropped from the new deal. Nothing is saved between rounds beyond
  the seating and the score.

### Two-player behaviour, stated explicitly

| Card                 | With 2 players                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Stop**             | Skips your opponent, so the turn returns to you — effectively an extra turn.                      |
| **Change Direction** | The direction flag flips, but the turn still passes to your opponent. It has no practical effect. |
| **Plus**             | Unchanged: you play again, or take a card instead.                                                |
| **+3**               | Your single opponent draws three, or breaks it and hands the three to you.                        |

### Robot players

A table may seat **robots**, and a robot plays by exactly these rules — the same legality
check, the same last-card declaration, the same penalties. Three things about them are rules
rather than implementation, so they are stated here:

- **A robot cannot see your cards.** It is given the public table and its own hand, which is
  what every other player has. It does not know the draw pile's order, and it does not know who
  holds a +3 Breaker.
- **A robot can be caught on its last card.** It declares after a moment, not instantly, and
  that moment is a real window: call it out and it draws four, like anybody else.
- **A robot will not call out a player who is not there.** Somebody who cannot shout cannot be
  caught for silence. A seat a robot is _playing_ is fair game, because the robot can shout.

A robot may also play a **human's** seat, when the table has that turned on — see the absent
player table below. That seat stays entirely its owner's: the same seat, the same name, the
same place in the standings, handed back the moment they act.

### Decisions we made where editions disagree

Each of these is a genuine fork. We picked one, implemented it, and tested it.

| Question                                          | Our rule                                                                                                                       | Why                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May a card drawn this turn be played immediately? | **No.** Drawing ends the turn.                                                                                                 | Simplest to explain and to see on screen; no "you could have played that" ambiguity.                                                                                                  |
| Must the card owed after a Plus be played?        | **No.** It may be paid from the draw pile, whatever the hand holds.                                                            | It was the one place in the game where a lit draw pile refused a tap, to enforce something no table enforces.                                                                         |
| How long is a last card safe from being called?   | **30 ms**, measured on the host's clock from when the hand reached one card.                                                   | Only enough to settle the ordering between the card landing and the button appearing; anything longer protects silence itself.                                                        |
| Does Super Taki change the colour?                | **No.** It takes the leading colour.                                                                                           | The reading that came in with the King, and the one the current edition prints.                                                                                                       |
| Does the +3 change the colour?                    | **No.**                                                                                                                        | Same principle: Change Colour is the only card that repaints the table.                                                                                                               |
| Who may answer a +3, and when?                    | **Any holder of a breaker, out of turn**, in a window that closes on the first answer.                                         | This is the card's whole point; restricting it to the next player would make it an ordinary defensive card.                                                                           |
| Change Direction with two players                 | **Turn passes to the opponent.**                                                                                               | Follows directly from the modular next-player calculation instead of adding a special case.                                                                                           |
| Can you win on a +2, +3 or Taki card?             | **Yes.** Any outstanding obligation is void.                                                                                   | An empty hand ends the round, and those obligations fall on somebody else or on nobody.                                                                                               |
| Can you win on a Plus?                            | **No.** You take the card the Plus owes and the turn passes.                                                                   | The obligation is on the player putting the card down, and it is a card they still owe the table — so the hand is not finished, and a round cannot end on a debt.                     |
| Colourless cards inside a Taki sequence           | **Not allowed.**                                                                                                               | A sequence is defined by a colour, and a colourless card has none.                                                                                                                    |
| Which effects apply when a sequence closes?       | **Only the last card's.**                                                                                                      | Otherwise a long sequence could chain several Stops, which no edition intends.                                                                                                        |
| Does a +2 run stack?                              | **Yes, by two per card, with no cap.**                                                                                         | This is the printed rule. There is no release valve: a run is answered with a +2 or paid for.                                                                                         |
| Does a King answer a +2 run?                      | **Yes.** It cancels the whole run and its owner draws nothing.                                                                 | The reading the printed rules give the King: it is the one card that undoes a penalty, and two in a deck of 116 keeps it rare.                                                        |
| "Last card" declaration and a penalty for silence | **Declared with a button; the win does not depend on it, but any other player may catch a silent single card for four cards.** | This is how it is played at a table: the declaration is enforced by the other players, not by the deal.                                                                               |
| A +3 Breaker with no +3 open                      | **Legal, and its owner draws the three.**                                                                                      | Refusing it left a card that could be unplayable all round. Charging its owner keeps it a defensive card rather than a second +3.                                                     |
| A Taki of another colour inside an open sequence  | **Legal onto a bare Taki, and it carries the run into its colour; illegal once an ordinary card has joined the run.**          | The run, not the top card, is what the permission hangs on — otherwise Red Taki → Red 3 → Red Taki → Yellow Taki would switch colour, which is the case players say plainly does not. |
| A Super Taki inside an open sequence              | **Legal onto a bare Taki, on the same terms, and it leaves the colour alone.**                                                 | A coloured Taki is legal on top of a Super Taki; the mirror of that has to hold, or "a Taki on a Taki" would mean one thing in one direction and another in the other.                |
| Is there a plain number 2?                        | **No.** The only 2 in the deck is the +2.                                                                                      | It is what the printed deck contains; a bare 2 read as a +2 that had lost its plus.                                                                                                   |
| Opening card is a special card                    | **It is buried at the bottom and the next card is drawn** until a number card appears.                                         | Keeps the first turn unambiguous without discarding cards.                                                                                                                            |
| Point scoring                                     | **None.** Standings show remaining cards.                                                                                      | Scoring systems vary wildly; card counts are unambiguous.                                                                                                                             |

### Worked examples

**1 — Symbol match across colours**

Top card: Red Stop. Current colour: red. You hold Green Stop and Green 4.
Green Stop is legal (same symbol); Green 4 is not (wrong colour, wrong symbol).

**2 — A Taki sequence with a trailing Stop, three players (Ann → Ben → Cat)**

Ann plays Red Taki → a red sequence opens, Ann keeps the turn.
Ann plays Red 3 → joins the sequence, nothing resolves.
Ann plays Red Stop → joins the sequence, still nothing resolves.
Ann presses **Close Taki** → the last card was a Stop, so **Ben is skipped** and it is
**Cat's** turn.

**3 — A +2 run**

Ann plays Red +2; Ben owes two. Ben plays Green +2; Cat owes four and the colour is green.
Cat holds neither a +2 nor a King, so she draws four and her turn ends. Play returns to Ann.

**4 — A King wipes a run**

Ann plays Red +2; Ben owes two and holds a King but no +2. He plays the King: the run is
cancelled, he draws nothing, the colour stays red, and the turn is still his with every card
in his hand legal — so he may put down Blue 7 even though nothing about it matches. Had the
run been stacked to six by then, the King would have wiped all six just the same.

**5 — A +3 that gets broken**

Ann plays a +3. Ben holds a breaker, so the table waits. Ben plays it: **Ann** draws three,
Ben and Cat draw nothing, and it is Ben's turn. Had Ben declined instead, Ben and Cat would
each have drawn three.

**6 — Super Taki**

Current colour: red. Ann plays Super Taki. A **red** sequence opens. Ann may play Red 3 and
Red Stop, but not Blue 3 (wrong colour) and not Change Colour (colourless). She closes; the
last card was Red Stop, so the next player is skipped.

**7 — Recycling**

The draw pile is empty and Cat must draw. The discard pile is Red 9, Red 2, Blue 2,
Yellow 2 (Yellow 2 on top). Yellow 2 stays face up; the other three are shuffled back; Cat
draws one of them; two remain in the draw pile.

**8 — A sequence keeps its colour to the end**

Ann plays Green Taki, then Green 3, then Green 7. She holds a Red Taki and would like to
carry on in red. She cannot: inside a sequence, colour is the only rule, and the Red Taki is
refused with `wrongTakiColor`. Her turn ends with the sequence she opened, in the colour she
opened it in. One turn is one sequence, and one colour.

**9 — A last card that is a Plus**

Ann is down to one card, Red Plus, and has declared it. She plays it: her hand is empty, and
the round does **not** end. The Plus owes one more card and she has none, so she takes one
from the draw pile and the turn passes to Ben. She is back on a single card — a different
one — so her declaration is gone and she must shout again, or Ben may call her out.

---

## עברית

### החבילה — 116 קלפים

| קלפים                                     | כמות      | סה"כ    |
| ----------------------------------------- | --------- | ------- |
| מספרים 1, 3–9, ארבעה צבעים, שניים מכל אחד | 8 × 4 × 2 | 64      |
| עצור, ארבעה צבעים, שניים מכל אחד          | 4 × 2     | 8       |
| פלוס, ארבעה צבעים, שניים מכל אחד          | 4 × 2     | 8       |
| קח 2, ארבעה צבעים, שניים מכל אחד          | 4 × 2     | 8       |
| שינוי כיוון, ארבעה צבעים, שניים מכל אחד   | 4 × 2     | 8       |
| טאקי, ארבעה צבעים, שניים מכל אחד          | 4 × 2     | 8       |
| שינוי צבע (ללא צבע)                       | —         | 4       |
| סופר טאקי (ללא צבע)                       | —         | 2       |
| מלך (ללא צבע)                             | —         | 2       |
| פלוס 3 (ללא צבע)                          | —         | 2       |
| שבירת פלוס 3 (ללא צבע)                    | —         | 2       |
| **סה"כ**                                  |           | **116** |

הצבעים: **אדום, כחול, ירוק, צהוב**.

**אין קלף 2 רגיל.** בטאקי ה־2 היחיד בחבילה הוא קלף קח 2, שמודפס כספרה 2 עם פלוס לצידה, ולכן
המספרים הם 1, 3, 4, 5, 6, 7, 8, 9. קלף מספר 2 נפרד הוא קלף שלא קיים בחבילה האמיתית, ועל
המסך הוא נראה כמו קח 2 שאיבד את הפלוס שלו.

**רק שינוי צבע משנה את הצבע המוביל.** מאז שקלף המלך נכנס לחבילה, שאר הקלפים חסרי הצבע —
סופר טאקי, מלך, פלוס 3 ושבירת פלוס 3 — מקבלים את הצבע שכבר מוביל. ניסיון לבחור להם צבע
נדחה בקוד `colorNotAllowed`.

### התחלה

- 2 עד 6 שחקנים, לפי סדר ההצטרפות, וסדר המושבים גלוי לכולם.
- החבילה מעורבבת בעזרת מחולל מספרים אקראיים עם זרע, כך שאותו זרע מחלק בדיוק את אותו משחק.
- כל שחקן מקבל **8 קלפים**.
- קלף הפתיחה הוא **קלף המספר הראשון** מראש החבילה. כל קלף מיוחד שנשלף בדרך עובר לתחתית
  חבילת המשיכה, כך שאף קלף לא הולך לאיבוד והתור הראשון תמיד חד־משמעי.
- השחקן במושב הראשון (המנחה) מתחיל, בכיוון "קדימה".

### מהלך תור

בתור שלך עושים בדיוק אחד מהשניים:

1. **מניחים קלף חוקי**, או
2. **מושכים מחבילת המשיכה** — קלף אחד כרגיל, או את כל קנס הקח־2 שנצבר. האפשרות הזו פתוחה
   תמיד, לא משנה מה ביד; הדבר היחיד שסוגר אותה הוא רצף טאקי פתוח שלכם, שצריך לסגור קודם.

קלף חוקי אם מתקיים אחד מאלה:

- הוא בצבע הנוכחי, או
- הוא באותו **סמל** כמו הקלף העליון — אותו מספר, או אותו סוג פעולה (עצור על עצור, קח 2 על
  קח 2, פלוס על פלוס וכן הלאה), או
- הוא קלף ללא צבע (שינוי צבע, סופר טאקי, מלך, פלוס 3), שחוקי על כל קלף עליון. הדבר היחיד
  שמצמצם את זה הוא קנס קח־2 פתוח: כל עוד חייבים קלפים, **רק קח 2 או מלך חוקיים**, עם צבע או
  בלי.

**שבירת פלוס 3 היא הנחה חוקית לגמרי, ויקרה**: כשאין פלוס 3 לשבור, שלושת הקלפים שהיא הייתה
מחזירה נמשכים בידי מי שהניח אותה. ראו למטה.

מהתאמת הסמלים נובע שעצור כחול חוקי על עצור אדום, וגם שכל קח 2 עונה לכל קח 2.

**סופר טאקי נחשב טאקי לצורך ההתאמה.** מודפס עליו טאקי ואין לו צבע משלו, ולכן טאקי בכל צבע
חוקי עליו — הסמלים מתאימים — וגם ההפך: סופר טאקי חוקי על כל טאקי. כל קריאה אחרת הייתה
משאירה שולחן שמראה טאקי ודוחה יד שמחזיקה טאקי.

**משיכה מסיימת את התור.** קלף שנמשך עכשיו לא נכנס לשולחן באותו תור, גם אם הוא חוקי.

**הנחת הקלף האחרון מנצחת בסבב**, עם הכרזה או בלעדיה. מה שקלף אחרון בלי הכרזה מסכן הוא
להיתפס לפני שמספיקים להניח אותו — ראו "אחרון בידי" למטה.

**חוץ מפלוס.** פלוס חייב עוד קלף אחד, ולמי שהרגע סיים את היד אין מה לתת — ולכן פלוס שמונח
כקלף אחרון לא מנצח: לוקחים קלף אחד מהקופה והתור עובר. זה הקלף היחיד בחבילה שלא יכול לסיים
סבב.

### קלפים מיוחדים

| קלף              | השפעה                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **עצור**         | השחקן הבא מפסיד את תורו. בשני שחקנים התור חוזר מיד אליך.                                                                                                                    |
| **פלוס**         | חייבים עוד קלף אחד: אפשר להניח אותו, ואפשר לקחת קלף מהקופה במקום. פלוס נוסף מחדש את החובה. כקלף אחרון הוא לא מנצח — לוקחים את הקלף שחייבים.                                 |
| **קח 2**         | השחקן הבא חייב שני קלפים — אלא אם יניח קח 2 משלו, שמעלה את הקנס בשניים ומעביר אותו הלאה.                                                                                    |
| **שינוי כיוון**  | סדר המשחק מתהפך. בשני שחקנים התור עובר בכל מקרה ליריב.                                                                                                                      |
| **שינוי צבע**    | אפשר להניח על כל קלף. בוחרים את הצבע הבא והתור עובר.                                                                                                                        |
| **טאקי**         | פותח רצף בצבע של הקלף — ראו למטה.                                                                                                                                           |
| **סופר טאקי**    | אפשר להניח על כל קלף. פותח רצף בצבע שכבר מוביל.                                                                                                                             |
| **מלך**          | אפשר להניח על כל קלף עליון, **כולל** כתשובה לקנס קח־2 פתוח, שהוא מבטל לגמרי. נותן תור חופשי בלי התאמה.                                                                      |
| **פלוס 3**       | כל שאר השחקנים מושכים שלושה קלפים — אלא אם מישהו שובר.                                                                                                                      |
| **שבירת פלוס 3** | מונחת **שלא בתור** כתשובה לפלוס 3: מי שהניח את הפלוס 3 מושך שלושה במקום, ואף אחד אחר לא. כשמניחים אותה בלי פלוס 3 פתוח היא קלף חסר צבע רגיל, ומי שהניח אותה מושך את השלושה. |

חובת פלוס היא חובה **לפעול**, לא חובה להניח: אפשר לשלם אותה מחבילת המשיכה גם כשיש ביד קלף
חוקי, ומשיכה מסיימת את התור בדיוק כמו בכל תור אחר. קלף שמניחים במקום נבחן לפי כללי ההתאמה
הרגילים, ולא חייב להיות באותו צבע. אותו דבר נכון לתור החופשי שהמלך נותן, שהוא אותו דגל:
אפשר לוותר עליו במשיכה. כלומר חבילת המשיכה פתוחה בכל תור שלכם חוץ ממצב אחד — רצף טאקי
פתוח.

### "אחרון בידי"

שחקן שנשאר עם קלף אחד חייב להכריז. זה הכלל היחיד בטאקי שהוא **הכרזה** ולא מהלך, וכך הוא גם
מיושם — כולל החלק שבו שאר השחקנים הם אלה שאוכפים אותו.

1. **מי מכריז ומתי.** כל מי שמחזיק **בדיוק קלף אחד**, בכל רגע, בתור או שלא בתור — גם כששאר
   השולחן קפוא בגלל פלוס 3. הכרזה אינה הנחה: היא לא נוגעת בתור, בצבע או בערמה.
2. **ההכרזה הולכת עם הקלף, לא עם השחקן.** ברגע שהיד מפסיקה להיות קלף אחד — משיכה, קנס קח 2,
   פלוס 3 שנפל עליך — ההכרזה מתבטלת. חזרה לקלף אחד דורשת הכרזה חדשה.
3. **הכרזה אחת לכל קלף.** הכרזה נוספת נדחית בקוד `alreadyDeclared`, והכרזה על יד בגודל אחר
   נדחית בקוד `nothingToDeclare`.
4. **ההכרזה אינה מה שמנצח את הסבב.** הנחת הקלף האחרון היא מה שמנצח. שחקן שלא הכריז מנצח
   בהנחת הקלף האחרון בדיוק כמו שחקן שהכריז.
5. **מה ששתיקה עולה הוא להיתפס.** כל עוד שחקן יושב על קלף בודד בלי שהכריז, **כל שחקן אחר**
   יכול לתפוס אותו, בתור או שלא בתור, והשותק לוקח **4 קלפים**. הלקיחה סוגרת את החלון מעצמה,
   כי היד כבר לא קלף בודד. תפיסה של מי שהכריז, של מי שלא נשאר לו קלף בודד, או של עצמך, נדחית
   בקוד `nothingToCatch`. **כל השולחן מקבל הודעה מי תפס**, לא רק ביומן: משלושה שחקנים ומעלה
   "מישהו לקח ארבעה" לא אומר של מי הייתה הקריאה.
6. **הרגע הראשון שייך לשחקן.** מרגע שהיד יורדת לקלף אחד, אי אפשר לתפוס אותו במשך
   **100 מילישניות**. החלון קיים כי שני חצאי הרגע אינם בו-זמניים על מסך כמו שהם בשולחן
   אמיתי: ההנחה צריכה להגיע למנחה, היד החדשה צריכה לחזור, ורק אז מופיע כפתור הכרזה במקום
   שהיה ריק — בזמן שכפתור התפיסה של כל יריב כבר על המסך וכבר מתחת לאצבע. קודם עמדו כאן
   30 מילישניות, שהיו קצרות מהלוך-חזור אחד ומסרו את ההפרש למי שבמקרה הסתכל; אחר כך עמדו כאן
   300, שכיסו מהדרך אל הכפתור יותר משחלון שמסדר סדר אמור לכסות. המידה היא הלוך-חזור, והדרך
   אל הכפתור נענית בסעיף 8 למטה. השעון של המנחה הוא זה שמודד, ותפיסה בתוך החלון נדחית בקוד
   `nothingToCatch` — עדיין אין את מי לתפוס. הכפתור לא מופיע אצל השאר עד שהחלון נסגר. חזרה
   לקלף בודד בהמשך קונה חלון חדש, בדיוק כמו שהיא דורשת הכרזה חדשה.
7. **ההכרזה פומבית.** מי שהכריז מופיע במצב השולחן שכולם רואים, בדיוק כמו הכרזה בקול בשולחן
   אמיתי. זה מה שמאפשר לתפוס בכלל, ולכן כל מושב עם קלף בודד מציג או "הכריז/ה" או כפתור לתפוס.
8. **אפשר להכריז יחד עם הקלף.** קלף שדורש בחירת צבע — שינוי צבע — מכניס חלון בחירה בין ההנחה
   לבין ההכרזה, כך שהחלון שבסעיף 6 נשרף על בחירת צבע במקום על הדרך לכפתור. כשקלף כזה עומד
   להשאיר אתכם עם קלף אחד, חלון הצבעים מציע גם את ההכרזה לצד ארבעת הצבעים: מדליקים אותה,
   בוחרים צבע, וההנחה וההכרזה הן מהלך אחד שמוחל יחד — בלי רגע ביניים שבו אפשר לתפוס.
   ההכרזה **כבויה כברירת מחדל**, כי הכלל שנאכף כאן הוא לזכור, ותיבה שזוכרת במקומכם היא כבר
   משחק אחר. המנחה מכבד אותה רק כשההנחה באמת משאירה קלף אחד ביד: הנחה שמרוקנת את היד מנצחת
   ממילא, ושבירת פלוס 3 שהונחה לריק מושכת קודם שלושה קלפים — בשני המקרים אין מה להכריז.

### רצפי קח 2

- הנחת **קח 2** קובעת קנס של שני קלפים ומעבירה את התור.
- מי שתורו יכול לענות ב**קח 2 בכל צבע**, שמעלה את הקנס לארבעה, אחר כך לשישה וכן הלאה. הצבע
  המוביל הוא של הקח 2 האחרון שהונח.
- **מלך מבטל את הקנס.** כשקנס פתוח שני קלפים חוקיים, והם עושים דברים הפוכים: קח 2 מעלה את
  הקנס ומעביר אותו הלאה, ומלך מוחק אותו. כל הקנס נעלם — שניים או עשרה — מי שהניח את המלך לא
  מושך כלום, וממשיך ישר לתור החופשי שהמלך תמיד נותן. כל קלף אחר עדיין נדחה בקוד
  `mustAnswerDraw`.
- מי שלא יכול או לא רוצה לענות **מושך את כל הקנס בבת אחת** ומפסיד את תורו.
- קח 2 שהונח **בתוך** רצף טאקי לא עושה דבר עד שהרצף נסגר; אם הוא הקלף האחרון, נפתח קנס
  כרגיל.

### המלך

המלך קונה תור שבו שום דבר לא חייב להתאים:

1. מניחים אותו על כל קלף עליון, בכל שלב בתור.
2. **הוא מבטל קנס קח־2 פתוח.** מלך שמונח כשחייבים קלפים מוחק את כל הקנס הפתוח — בכל גובה
   שהצטבר — ומי שהניח אותו לא מושך כלום. הביטול נרשם ביומן יחד עם מספר הקלפים שאף אחד לא לקח.
3. הצבע המוביל לא משתנה, גם כשהוא מבטל קנס: הצבע שקבע הקח 2 האחרון פשוט נשאר.
4. משחקים שוב, ובתור החופשי הזה **כל קלף ביד חוקי** — אין התאמת צבע או סמל. ההנחה קובעת את
   הצבע כרגיל.
5. אפשר לוותר על התור החופשי כמו על כל חובה אחרת: משיכת **קלף אחד** מהקופה מסיימת את התור.
   הקנס שהמלך ביטל כבר נעלם, ולכן הקלף הבודד הזה הוא כל המחיר.
6. יד ריקה בשלב הזה כבר הייתה ניצחון, כך שאין מצב תקוע — מלך שהונח כקלף האחרון מנצח את
   הסבב, עם קנס פתוח או בלעדיו.

### פלוס 3 ושבירת פלוס 3

פלוס 3 הוא הקלף היחיד שמשעה את סדר התורות.

1. שחקן מניח **פלוס 3**. הצבע המוביל לא משתנה.
2. המנוע מחפש שחקנים אחרים שמחזיקים **שבירת פלוס 3**. אם אין כאלה, הקלף חל מיד: כל השאר
   מושכים שלושה.
3. אם יש, השולחן קופא. כל פקודה אחרת נדחית בקוד `awaitingBreak`, כולל של מי שהניח את
   הפלוס 3.
4. כל מחזיק בוחר: להניח את השבירה או לוותר (`passBreak`). **השבירה הראשונה** סוגרת את
   החלון: מי שהניח את הפלוס 3 מושך שלושה, ואף אחד אחר לא. אם כולם מוותרים, הקלף חל כמו
   בשלב 2.
5. בכל מקרה המשחק ממשיך מהמושב שאחרי מי שהניח את הפלוס 3.

**שבירה בלי מה לשבור.** היא עדיין קלף חוקי — חסר צבע, ולכן אפשר להניח אותו על כל דבר — אבל
שלושת הקלפים הולכים למי שהניח אותה, והם נמשכים **לפני** בדיקת הניצחון, כך שהיא לא יכולה
לשמש דרך חינם להיפטר מקלף אחרון. ויתור (`passBreak`) בלי פלוס 3 פתוח עדיין נדחה בקוד
`noPlusThreeOpen`: אין על מה לוותר.

**אף פעם לא מפרסמים מי מחזיק שבירה.** מצב השולחן הציבורי אומר רק שפלוס 3 פתוח ומי הניח
אותו; רשימת הממתינים נשארת אצל המנחה. כל לקוח מסיק אם הוא יכול לענות מהיד שלו, שאותה הוא
כבר יודע.

### רצפי טאקי

- הנחת קלף **טאקי** פותחת רצף שנעול לצבע של אותו קלף.
- כל עוד הרצף פתוח אפשר להניח **כמה קלפים שרוצים באותו צבע**, כולל קלפים מיוחדים וקלפי
  טאקי נוספים.
- **קלפים ללא צבע לא נכנסים לרצף.** שינוי צבע, מלך, פלוס 3 ושבירת פלוס 3 נדחים בקוד
  `wildNotAllowedInTaki`. סופר טאקי הוא היוצא מן הכלל היחיד, ורק במקרה שבסעיף הבא — הוא
  טאקי, וכל כלל על טאקי שמונח על טאקי חל גם עליו.
- **קלף רגיל בצבע אחר נדחה** בקוד `wrongTakiColor`, גם אם הסמל שלו מתאים לקלף העליון. בתוך
  רצף, הצבע הוא הכלל.
- **טאקי שמונח ישירות על טאקי אחר ממשיך את הרצף, מה שלא יהיה מודפס עליו.** כל עוד כל
  הקלפים שהונחו ברצף הם קלפי טאקי, אפשר להניח עליו **כל** טאקי — צבעוני או סופר. טאקי
  צבעוני מעביר את הרצף לצבע שלו; לסופר טאקי אין צבע משלו, ולכן הוא משאיר את הרצף בדיוק
  בצבע שבו היה. כך או כך הרצף ממשיך בלי הפסקה, וממשיכים להניח קלפים בצבע הרצף ואז סוגרים
  כרגיל. אפשר לעשות את זה יותר מפעם אחת, כך שטאקי אדום ← טאקי כחול ← טאקי ירוק הוא רצף
  ירוק, וטאקי אדום ← סופר טאקי ← טאקי כחול הוא רצף כחול.
- **ברגע שקלף רגיל נכנס לרצף, הצבע נסגר.** אחרי טאקי אדום ← אדום 3, שום טאקי לא פותח מחדש
  את הבחירה — גם לא טאקי אדום ← אדום 3 ← טאקי אדום ← טאקי צהוב, שבו טאקי נמצא למעלה ולא
  הונח עליו כלום. מה שקובע הוא הרצף, לא הקלף העליון.
- טאקי שמונח על טאקי **כשאין רצף פתוח** הוא התאמת סמל רגילה, והוא פותח רצף משלכם בצבע הקלף
  שהנחתם.
- **אי אפשר למשוך קלף כשרצף פתוח.** קודם סוגרים אותו (`cannotDrawDuringTaki`).
- סוגרים את הרצף בכפתור **סגירת טאקי**. אפשר לסגור בכל רגע, וחייבים לסגור כשנגמרו הקלפים
  באותו צבע.
- **כשהרצף נסגר חלה רק ההשפעה של הקלף האחרון שהונח.** לקלפים שהונחו לפניו אין השפעה כלל:
  - קלף אחרון מספר או טאקי → התור עובר כרגיל;
  - קלף אחרון **עצור** → השחקן הבא מדלג;
  - קלף אחרון **פלוס** → חייבים להניח עוד קלף, מחוץ לרצף ולפי ההתאמה הרגילה;
  - קלף אחרון **קח 2** → נפתח קנס של שניים מול השחקן הבא;
  - קלף אחרון **שינוי כיוון** → הכיוון מתהפך ואז התור עובר.
- מי שנגמרו לו הקלפים בתוך רצף מנצח מיד — אלא אם הקלף שסיים את היד היה **פלוס**, שחייב עוד
  קלף. אז הרצף נסגר, לוקחים קלף מהקופה עבור הפלוס, והתור עובר.

### סופר טאקי

סופר טאקי הוא טאקי ללא צבע שמקבל את הצבע שכבר במשחק:

1. מניחים אותו על כל קלף.
2. נפתח רצף ב**צבע הנוכחי**. לא בוחרים צבע, וניסיון לבחור נדחה ב-`colorNotAllowed`.
3. משם הרצף מתנהג בדיוק כמו רצף טאקי: רק אותו צבע, בלי קלפים ללא צבע (חוץ מטאקי, ראו
   סעיף 6), סגירה מפורשת, והשפעת הקלף האחרון בסגירה.
4. אם סוגרים כשהסופר טאקי עדיין הקלף העליון, התור פשוט עובר והצבע לא משתנה.
5. הוא מתאים כטאקי. ברגע שהוא הקלף העליון, טאקי צבעוני מכל יד הוא התאמת סמל רגילה עליו,
   אחרי שהרצף נסגר — אין סיבה שהשחקן הבא יחפש דווקא את הצבע המוביל רק מפני שהקלף שקבע אותו
   הוא חסר צבע.
6. ואותו דבר בכיוון ההפוך, בתוך רצף: כל עוד הרצף הוא רק קלפי טאקי, אפשר להניח עליו סופר
   טאקי. טאקי צבעוני חוקי על סופר טאקי, ולכן סופר טאקי חייב להיות חוקי על טאקי — אחרת הכלל
   היה נקרא לכיוון אחד בלבד. הוא לא מעביר כלום: הרצף נשאר בצבע שבו כבר היה.

### סדר ההשפעות בהנחת קלף

1. הקלף יוצא מהיד ועולה על הערמה.
2. הצבע הנוכחי הופך לצבע הקלף, לצבע שנבחר בשינוי צבע, או נשאר כפי שהיה בכל קלף אחר ללא
   צבע.
3. **בדיקת ניצחון:** היד ריקה → הסבב נגמר בניצחון, ושום דבר אחר לא חל. היוצא מן הכלל היחיד
   הוא **פלוס**: היד עדיין חייבת קלף, ולכן נמשך קלף מהקופה, רצף פתוח שלכם נסגר, והתור עובר
   במקום שהסבב ייגמר.
4. אם הקלף היה שבירת פלוס 3 → הפלוס 3 הפתוח מסתדר והתור ממשיך.
5. אם רצף פתוח → הקלף רק מצטרף לרצף, ואף השפעה לא חלה עדיין.
6. אחרת, אם הקלף טאקי או סופר טאקי → נפתח רצף והתור נשאר אצלך.
7. אחרת, ההשפעה של הקלף חלה (דילוג / קלף נוסף / קנס / היפוך כיוון / ביטול / העברת תור).

### כשנגמרים הקלפים למשיכה

כשחבילת המשיכה ריקה ומישהו חייב למשוך, כל הערמה **חוץ מהקלף העליון הגלוי** מעורבבת חזרה
לחבילת המשיכה, באותו מחולל אקראי עם זרע. הקלף העליון נשאר גלוי כדי לשמור על הצבע והסמל
שבמשחק, ואף קלף לא נעלם — יש בדיקה שמאמתת שכל מזהי הקלפים נשמרים.

אם באמת לא נשאר מה למשוך, התור פשוט עובר. אף שחקן לא נתקע.

### סוגי משחק

סוג המשחק נבחר בהגדרות בעת פתיחת השולחן, וניתן לשנות אותו בהגדרות החדר עד לחלוקת הקלפים.
ברגע החלוקה הוא נקבע לסבב: סבב מנוצח לפי הסוג שבו הוא חולק, גם אם ההגדרה של השולחן משתנה
אחר כך.

| סוג             | מה זה אומר להישאר בלי קלפים                               |
| --------------- | --------------------------------------------------------- |
| **רגיל**        | ניצחת בסבב.                                               |
| **טאקי מדרגות** | סיימת יד אחת מתוך שמונה, ומקבל/ת את היד הבאה — קטנה באחד. |

**טאקי מדרגות**, במלואו:

- הסבב נפתח בדיוק כמו סבב רגיל: **8 קלפים** לכל שחקן.
- מי שנגמרים לו הקלפים מקבל מיד יד חדשה, **קטנה באחד**: 8, אחר כך 7, 6, 5, 4, 3, 2, ולבסוף 1.
- מי שמסיים גם את היד של **קלף אחד** — כלומר סיים שמונה ידיים — מנצח בסבב. פלוס לא יכול
  להיות הקלף שעושה את זה: כמו בסבב רגיל הוא חייב עוד קלף, ולכן לוקחים קלף מהקופה ונשארים
  במדרגה האחרונה.
- הקלפים החדשים נלקחים מחבילת המשיכה, שמתמלאת מערמת ההשלכה כרגיל, כך שמדרגות הן בערך
  שלושים ושישה קלפים לשחקן ולא שמונה.
- שום דבר אחר לא משתנה. המדרגה קורית בתוך התור שגרם לה, ושאר התור נמשך בדיוק כרגיל: פלוס
  עוד נותן קלף נוסף לשחק, עצור עוד מדלג על המושב הבא, ורצף טאקי שהיה פתוח נשאר פתוח —
  ממשיכים אותו עם היד שהתקבלה עכשיו. פלוס נדחה רק במדרגה שהייתה **מנצחת**; בכל השאר היד
  החדשה היא שמשלמת עליו.
- נקודה שכדאי לומר במפורש: המדרגה אל היד האחרונה משאירה קלף בודד ביד, ולכן **הכלל של
  "אחרון בידי" חל עליו כמו על כל קלף בודד** — צריך להכריז, או שאפשר להיתפס. הכרזה שנעשתה
  על הקלף שהונח _אינה_ עוברת ליד החדשה; היד החדשה דורשת הכרזה משלה.
- הטבלה המסכמת של סבב מדרגות מסודרת לפי **ידיים שהושלמו** קודם, ולפי הקלפים שנשארו אחר כך,
  כי שחקן במדרגה אחת מהסוף יכול להחזיק יותר קלפים ממי שלא סיים אף יד.

### סוף הסבב

- הסבב מנוצח על ידי סיום הקלפים ביד — ובמדרגות, על ידי סיום היד השמינית — בכל קלף חוץ
  מפלוס, שחייב עוד קלף ונענה מהקופה.
- הטבלה המסכמת מציגה את כולם לפי מספר הקלפים שנשארו, מהמעט לרב; תוצאות שוות חולקות מקום.
  בסבב מדרגות נוספת עמודה של ידיים שהושלמו, והדירוג נקבע לפיה קודם.
- **ניקוד.** החדר שומר ניקוד מצטבר של **סבבים שנוצחו** — רק נצחונות, בלי נקודות על הקלפים
  שנשארו למפסידים — ומציג אותו לצד הטבלה המסכמת בסוף כל סבב. הניקוד שייך לחדר: הוא מתחיל
  מאפס כשהחדר נפתח, מי שעוזב לגמרי לוקח את הניקוד שלו איתו, וסגירת החדר מאפסת אותו לחלוטין.
- **סבב נוסף** מתחיל כשכל השחקנים המחוברים מסכימים. מי שלא חזר מנותק מהחלוקה החדשה. שום
  דבר לא נשמר בין סבבים חוץ מסדר המושבים והניקוד.

### התנהגות בשני שחקנים

| קלף             | בשני שחקנים                                                         |
| --------------- | ------------------------------------------------------------------- |
| **עצור**        | מדלג על היריב, כך שהתור חוזר אליך — בפועל תור נוסף.                 |
| **שינוי כיוון** | דגל הכיוון מתהפך, אבל התור עובר בכל מקרה ליריב. אין לו השפעה מעשית. |
| **פלוס**        | בלי שינוי: משחקים שוב, או לוקחים קלף במקום.                         |
| **פלוס 3**      | היריב היחיד מושך שלושה, או שובר ומעביר את השלושה אליך.              |

### החלטות שקיבלנו במקומות שהמהדורות חולקות

| שאלה                                        | ההחלטה                                                                           | הנימוק                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| האם קלף שנמשך עכשיו אפשר להניח מיד?         | **לא.** משיכה מסיימת את התור.                                                    | הכי פשוט להסביר ולראות על המסך.                                                                                                               |
| האם חייבים להניח את הקלף שחייבים אחרי פלוס? | **לא.** אפשר לשלם אותו מהקופה, לא משנה מה ביד.                                   | זה היה המקום היחיד במשחק שבו חבילת משיכה דלוקה סירבה ללחיצה.                                                                                  |
| כמה זמן קלף אחרון מוגן מתפיסה?              | **30 מילישניות**, לפי שעון המנחה מרגע שהיד ירדה לקלף אחד.                        | רק כדי לסדר את הסדר בין נחיתת הקלף להופעת הכפתור; כל חלון ארוך יותר מגן על השתיקה עצמה.                                                       |
| האם סופר טאקי משנה צבע?                     | **לא.** הוא מקבל את הצבע המוביל.                                                 | הקריאה שנכנסה עם קלף המלך, וזו שבמהדורה הנוכחית.                                                                                              |
| האם פלוס 3 משנה צבע?                        | **לא.**                                                                          | אותו עיקרון: רק שינוי צבע צובע מחדש את השולחן.                                                                                                |
| מי יכול לענות לפלוס 3, ומתי?                | **כל מחזיק שבירה, שלא בתור**, עד לתשובה הראשונה.                                 | זה כל הרעיון של הקלף; הגבלה לשחקן הבא הייתה הופכת אותו לקלף רגיל.                                                                             |
| שינוי כיוון בשני שחקנים                     | **התור עובר ליריב.**                                                             | נובע ישירות מחישוב השחקן הבא, בלי מקרה מיוחד.                                                                                                 |
| ניצחון בקלף קח 2, פלוס 3 או טאקי            | **מנצחים.** כל חובה שנותרה מתבטלת.                                               | יד ריקה מסיימת את הסבב, והחובות האלה נופלות על מישהו אחר או על אף אחד.                                                                        |
| ניצחון בקלף פלוס                            | **לא.** לוקחים את הקלף שהפלוס חייב והתור עובר.                                   | החובה היא של מי שהניח את הקלף, וזה קלף שהוא עדיין חייב לשולחן — היד לא הסתיימה, וסבב לא נגמר על חוב.                                          |
| קלפים ללא צבע בתוך רצף                      | **אסור.**                                                                        | רצף מוגדר על ידי צבע, ולקלף ללא צבע אין.                                                                                                      |
| טאקי בצבע אחר בתוך רצף פתוח                 | **מותר ישירות על טאקי, ומעביר את הרצף לצבע שלו; אסור אחרי שקלף רגיל נכנס לרצף.** | מה שקובע הוא הרצף ולא הקלף העליון — אחרת טאקי אדום ← אדום 3 ← טאקי אדום ← טאקי צהוב היה מחליף צבע, וזה בדיוק המקרה ששחקנים אומרים שאינו חוקי. |
| סופר טאקי בתוך רצף פתוח                     | **מותר ישירות על טאקי, באותם תנאים, ומשאיר את הצבע כמו שהוא.**                   | טאקי צבעוני חוקי על סופר טאקי; התמונה ההפוכה חייבת להתקיים גם היא, אחרת "טאקי על טאקי" היה אומר דבר אחד בכיוון אחד ודבר אחר בכיוון השני.      |
| אילו השפעות חלות בסגירת רצף?                | **רק של הקלף האחרון.**                                                           | אחרת רצף ארוך היה משרשר כמה קלפי עצור.                                                                                                        |
| האם קנס קח־2 מצטבר?                         | **כן, בשניים לכל קלף, בלי תקרה.**                                                | זה החוק המודפס. אין שסתום שחרור: עונים בקח 2 או משלמים.                                                                                       |
| האם מלך עונה לקנס קח־2?                     | **כן.** הוא מבטל את כל הקנס, ומי שהניח אותו לא מושך כלום.                        | זו הקריאה של החוק המודפס למלך: הקלף היחיד שמבטל קנס, ושניים ב־116 קלפים שומרים על נדירותו.                                                    |
| הכרזה על "קלף אחרון" וקנס על שתיקה          | **מיושם.** מי ששותק על קלף בודד נחשף לתפיסה.                                     | ההכרזה חוקית מכל מושב ובכל רגע, בדיוק כמו צעקה בשולחן אמיתי.                                                                                  |
| תפיסה של שחקן שאינו נוכח                    | **אסורה.**                                                                       | מי שלא כאן לא יכול להכריז, ולכן זו לא תפיסה אלא קציר.                                                                                         |
| קלף פתיחה מיוחד                             | **עובר לתחתית החבילה** עד שנשלף קלף מספר.                                        | שומר על תור ראשון חד־משמעי בלי לזרוק קלפים.                                                                                                   |
| ניקוד                                       | **אין.** הטבלה מציגה קלפים שנשארו.                                               | שיטות הניקוד משתנות מאוד; מספר קלפים חד־משמעי.                                                                                                |

### דוגמאות

**1 — התאמה לפי סמל בין צבעים**

הקלף העליון: עצור אדום. הצבע הנוכחי: אדום. ביד יש עצור ירוק וירוק 4.
עצור ירוק חוקי (אותו סמל); ירוק 4 לא (צבע לא מתאים, סמל לא מתאים).

**2 — רצף טאקי שמסתיים בעצור, שלושה שחקנים (אן → בן → קת)**

אן מניחה טאקי אדום → נפתח רצף אדום, התור נשאר אצלה.
אן מניחה אדום 3 → מצטרף לרצף, שום דבר לא חל.
אן מניחה עצור אדום → מצטרף לרצף, עדיין שום דבר לא חל.
אן לוחצת **סגירת טאקי** → הקלף האחרון היה עצור, לכן **בן מדלג** והתור עובר ל**קת**.

**3 — קנס קח 2 שמצטבר**

אן מניחה קח 2 אדום; בן חייב שניים. בן מניח קח 2 ירוק; קת חייבת ארבעה והצבע ירוק. לקת אין
לא קח 2 ולא מלך, ולכן היא מושכת ארבעה ותורה נגמר. התור חוזר לאן.

**4 — מלך מוחק קנס**

אן מניחה קח 2 אדום; בן חייב שניים, ויש לו מלך אבל אין לו קח 2. הוא מניח את המלך: הקנס
מתבטל, הוא לא מושך כלום, הצבע נשאר אדום, והתור עדיין שלו וכל קלף ביד חוקי — כך שהוא יכול
להניח כחול 7 למרות ששום דבר בו לא מתאים. אם הקנס היה מצטבר לשישה עד אז, המלך היה מוחק את
כל השישה בדיוק אותו דבר.

**5 — פלוס 3 שנשבר**

אן מניחה פלוס 3. לבן יש שבירה, ולכן השולחן ממתין. בן מניח אותה: **אן** מושכת שלושה, בן וקת
לא מושכים כלום, והתור של בן. אם בן היה מוותר, בן וקת היו מושכים שלושה כל אחד.

**6 — סופר טאקי**

הצבע הנוכחי אדום. אן מניחה סופר טאקי, ונפתח רצף **אדום**. אן יכולה להניח אדום 3 ועצור
אדום, אבל לא כחול 3 (צבע לא מתאים) ולא שינוי צבע (ללא צבע). היא סוגרת; הקלף האחרון היה
עצור אדום, לכן השחקן הבא מדלג.

**7 — עירוב מחדש**

חבילת המשיכה ריקה וקת חייבת למשוך. בערמה יש אדום 9, אדום 2, כחול 2, צהוב 2 (צהוב 2
למעלה). צהוב 2 נשאר גלוי; שלושת האחרים מעורבבים חזרה; קת מושכת אחד מהם; שניים נשארים
בחבילה.

**8 — רצף שומר על הצבע שלו עד הסוף**

אן מניחה טאקי ירוק, אחריו ירוק 3, אחריו ירוק 7. ביד שלה יש טאקי אדום והיא רוצה להמשיך
באדום. אי אפשר: בתוך רצף הצבע הוא הכלל היחיד, והטאקי האדום נדחה בקוד `wrongTakiColor`.
התור שלה נגמר עם הרצף שפתחה, בצבע שבו פתחה אותו. תור אחד הוא רצף אחד, וצבע אחד.

**9 — קלף אחרון שהוא פלוס**

לאן נשאר קלף אחד, פלוס אדום, והיא הכריזה עליו. היא מניחה אותו: היד ריקה, והסבב **לא** נגמר.
הפלוס חייב עוד קלף ואין לה, ולכן היא לוקחת קלף מהקופה והתור עובר לבן. היא שוב עם קלף בודד —
אחר — ולכן ההכרזה שלה פגה והיא צריכה להכריז מחדש, אחרת בן יכול לתפוס אותה.

## שחקן שאינו נוכח

התנתקות אינה החלטה, ולכן היא לא נענשת. אלה הכללים המדויקים כשמגיע התור של מי שאינו כאן:

| מצב השולחן                                | מה קורה                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| חלון שבירה של פלוס 3 מחכה למושב שאינו כאן | הוויתור מוחל בשמו **מיד**, בלי המתנה. אם החלון נסגר, הפלוס 3 מתיישב כמו ויתור רגיל. אף אירוע לא חושף מי החזיק שובר.                                 |
| לא התור שלו                               | שום דבר. אף פעם לא מדלגים על תור עתידי — הוא עוד עשוי לחזור.                                                                                        |
| רצף טאקי פתוח שהוא בעליו                  | הרצף נסגר דרך אותה פעולה שסוגרת רצף רגיל, כולל השפעת הקלף האחרון. רק פלוס משאיר את התור אצלו, ואז ממשיכים לשורה הבאה.                               |
| חוב של קח 2                               | **משולם במלואו.** זו חובה שמישהו אחר יצר: ביטולה היה מוחק קלפים מהמשחק או מפיל את הרצף על השחקן הבא, ובעיקר היה הופך ניתוק לתשובה הזולה ביותר לרצף. |
| תור חופשי אחרי מלך                        | **מתבטל, בלי קנס.** המלך כבר ביטל כל חוב; התור החופשי הוא מתנה, ואין קנס על מתנה שלא נוצלה.                                                         |
| חובת פלוס                                 | **מתבטלת, בלי קנס.**                                                                                                                                |
| תור רגיל                                  | **התור עובר, בלי קנס.**                                                                                                                             |
| הוא מחזיק קלף בודד ולא הכריז              | **אי אפשר לתפוס אותו** כל זמן שאינו נוכח. חוזר להיות רגיל ברגע שהוא מתחבר.                                                                          |
| חזר בתוך חלון ההמתנה                      | הדילוג מבוטל והוא מקבל תור מלא.                                                                                                                     |
| עזב את הסבב לתמיד                         | המושב **מסומן** ולא נמחק: הקלפים שלו קפואים מחוץ למשחק, הוא נשאר בטבלה המסכמת, וסך הקלפים במשחק אינו משתנה.                                         |
| נשארו פחות משני שחקנים                    | הסבב מסתיים **בלי מנצח**. "האחרון שנשאר מנצח" היה מעניק את הסבב למי שמודד את ההתנתקות.                                                              |

#### רובוט שממלא מקום

אם השולחן בחר בכך (זו הגדרה של החדר, וברירת המחדל מופעלת), רובוט מתחיל לשחק את היד של מי שאינו
כאן **אחרי 45 שניות** של היעדרות — הרבה אחרי שהתור שלו כבר עבר בחינם פעם או פעמיים — או אחרי
**90 שניות** שבהן הוא מחובר אבל לא מבקש שום דבר. השורה החשובה היא האחרונה: **ברגע שהוא מבקש
משהו, המושב חוזר אליו**, עוד לפני שהבקשה שלו מוחלת. המושב נשאר שלו לכל דבר — השם, האסימון
לחזרה, והמקום בטבלה המסכמת.

לא ממלאים מקום של מי ש**נפרד לשלום** (זו החלטה, לא תקלה), של מי שנראה **בדרך חזרה**, של מי
ש**עזב את הסבב**, ולא בזמן ש**השולחן בהמתנה**. רובוט שמשחק מושב של אדם **אפשר לתפוס** על קלף
אחרון בדיוק כמו כל שחקן אחר. הפירוט המלא: [robots.md](robots.md).
