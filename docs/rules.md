# Rules of Super Taki / חוקי סופר טאקי

These are the **exact** rules the engine implements. Where editions of Taki disagree, one
interpretation was chosen, documented here, and covered by tests. The app itself has no
rules page: this file is the specification.

Every rule below corresponds to at least one unit test in `tests/unit/engine/`.

---

## English

### The deck — 124 cards

| Cards                                       | Count     | Total   |
| ------------------------------------------- | --------- | ------- |
| Numbers 1–9, four colours, two of each      | 9 × 4 × 2 | 72      |
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
| **Deck total**                              |           | **124** |

Colours: **red, blue, green, yellow**.

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
2. **Draw from the draw pile** — one card normally, or the whole outstanding +2 run.

A card is legal when any of these holds:

- it matches the **current colour**, or
- it matches the **symbol** of the top card — the same number value, or the same action
  kind (Stop on Stop, +2 on +2, Plus on Plus, and so on), or
- it is a **colourless card** (Change Colour, Super Taki, King, +3), which is always legal.

A **+3 Breaker is never legal as an ordinary play**; it exists only to answer an open +3,
and the engine rejects it with `noPlusThreeOpen` at any other moment.

Note the consequence of symbol matching: a Blue Stop is legal on a Red Stop, because the
_symbols_ match even though the colours do not. The same is what lets any +2 answer any +2.

**Drawing ends your turn.** A card you just drew may not be played in the same turn, even
if it is legal. (Chosen for clarity; some variants allow it.)

**Playing your last card wins the round immediately.**

### Special cards

| Card                 | Effect                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stop**             | The next player loses their turn. With two players the turn comes straight back to you.                                                    |
| **Plus**             | You must play one more card. If you hold nothing legal, you draw one card and your turn ends. A second Plus repeats the obligation.        |
| **+2**               | The next player owes two cards — unless they add a +2 of their own, which raises the run by two and passes it on. See below.               |
| **Change Direction** | The play order reverses. With two players the turn still passes to your opponent.                                                          |
| **Change Colour**    | Playable on anything. You choose the next colour, and your turn ends.                                                                      |
| **Taki**             | Opens a sequence in that card's colour — see below.                                                                                        |
| **Super Taki**       | Playable on anything. Opens a sequence in the colour already leading.                                                                      |
| **King**             | Playable on anything, including an open +2 run. Cancels every pending penalty and obligation, then gives you a free turn with no matching. |
| **+3**               | Every other player draws three cards — unless somebody breaks it. See below.                                                               |
| **+3 Breaker**       | Playable **out of turn**, only in answer to a +3. The player who played the +3 draws three cards instead, and nobody else draws.           |

While a Plus obligation is outstanding you **must play if you can**: the draw pile is
disabled, and the engine rejects a draw with `mustPlayAfterPlus`. The card you owe follows
normal matching rules — it does not have to be the same colour as the Plus.

### +2 runs

- Playing a **+2** sets the outstanding penalty to two cards and passes the turn.
- The player to move may answer with **another +2 of any colour**, which raises the run to
  four, then six, and so on. The colour of the run follows the last +2 played.
- A **King** also answers a run, and wipes it out entirely.
- Nothing else is legal while a run is open: the engine rejects any other card with
  `mustAnswerDraw`.
- A player who will not or cannot answer **draws the whole run at once** and loses their
  turn. Drawing two is a single decision, not two separate draws.
- A +2 played **inside** a Taki sequence does nothing until the sequence closes; then, if
  it was the last card, it opens a run in the usual way.

### The King

The King is the answer to everything:

1. Play it on any top card, at any point in your turn, including against an open +2 run.
2. Any outstanding +2 run and any Plus obligation are cancelled.
3. The leading colour does not change.
4. You then play again, and on that free turn **every card in your hand is legal** —
   colour and symbol do not apply. Playing it sets the colour as usual.
5. If your hand were somehow empty you would already have won; there is no stuck state.

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

**Who holds a breaker is never published.** The public table state says only that a +3 is
open and who played it; the list of players being waited for stays on the host. A client
works out whether it may answer by looking at its own hand, which it already knows.

### Taki sequences

- Playing a **Taki** card opens a sequence locked to that card's colour.
- While the sequence is open you may play **any number of further cards of that colour**,
  including other special cards and further Taki cards.
- **Colourless cards cannot enter a sequence.** Change Colour, Super Taki, King, +3 and the
  +3 Breaker have no colour, so the engine rejects them with `wildNotAllowedInTaki`.
- A card of a different colour is rejected with `wrongTakiColor`, even if its symbol
  matches the top card. Inside a sequence, colour is the only rule.
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
- Emptying your hand during a sequence wins immediately.

### Super Taki

Super Taki is a colourless Taki that takes the colour already in play:

1. Play it on anything.
2. A sequence opens in the **current colour**. You are not asked to choose, and asking is
   rejected with `colorNotAllowed`.
3. From there it behaves exactly like a Taki sequence: same-colour cards only, no
   colourless cards, explicit close, last-card effect on closing.
4. If you close the sequence with the Super Taki still the top card, the turn simply passes
   and the colour is unchanged.

### Effect order when a card is played

1. The card leaves your hand and goes on top of the discard pile.
2. The current colour becomes the card's colour, your chosen colour for a Change Colour, or
   stays as it was for any other colourless card.
3. **Win check:** hand empty → the round ends, you win, nothing else resolves.
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

### End of the round

- The first player to empty their hand wins.
- The final table lists everyone by remaining cards, fewest first; ties share a place.
- There is no point scoring. Each game is one round.
- **Play again** starts a new round when **every connected player agrees**. Players who
  never reconnected are dropped from the new deal. Nothing is saved between rounds beyond
  the seating.

### Two-player behaviour, stated explicitly

| Card                 | With 2 players                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Stop**             | Skips your opponent, so the turn returns to you — effectively an extra turn.                      |
| **Change Direction** | The direction flag flips, but the turn still passes to your opponent. It has no practical effect. |
| **Plus**             | Unchanged: you play again.                                                                        |
| **+3**               | Your single opponent draws three, or breaks it and hands the three to you.                        |

### Decisions we made where editions disagree

Each of these is a genuine fork. We picked one, implemented it, and tested it.

| Question                                          | Our rule                                                                               | Why                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| May a card drawn this turn be played immediately? | **No.** Drawing ends the turn.                                                         | Simplest to explain and to see on screen; no "you could have played that" ambiguity.                                           |
| Does Super Taki change the colour?                | **No.** It takes the leading colour.                                                   | The reading that came in with the King, and the one the current edition prints.                                                |
| Does the +3 change the colour?                    | **No.**                                                                                | Same principle: Change Colour is the only card that repaints the table.                                                        |
| Who may answer a +3, and when?                    | **Any holder of a breaker, out of turn**, in a window that closes on the first answer. | This is the card's whole point; restricting it to the next player would make it an ordinary defensive card.                    |
| Change Direction with two players                 | **Turn passes to the opponent.**                                                       | Follows directly from the modular next-player calculation instead of adding a special case.                                    |
| Can you win on a Plus, +2, +3 or Taki card?       | **Yes.** Any outstanding obligation is void.                                           | An empty hand ends the round; requiring a further card from an empty hand is incoherent.                                       |
| Colourless cards inside a Taki sequence           | **Not allowed.**                                                                       | A sequence is defined by a colour, and a colourless card has none.                                                             |
| Which effects apply when a sequence closes?       | **Only the last card's.**                                                              | Otherwise a long sequence could chain several Stops, which no edition intends.                                                 |
| Does a +2 run stack?                              | **Yes, by two per card, with no cap.**                                                 | This is the printed rule, and the King is the release valve.                                                                   |
| "Last card" declaration and a penalty for silence | **Not implemented.**                                                                   | Enforcing it fairly needs a timing rule we chose not to invent. Card counts are always visible, which serves the same purpose. |
| Opening card is a special card                    | **It is buried at the bottom and the next card is drawn** until a number card appears. | Keeps the first turn unambiguous without discarding cards.                                                                     |
| Point scoring                                     | **None.** Standings show remaining cards.                                              | Scoring systems vary wildly; card counts are unambiguous.                                                                      |

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
Cat holds no +2 and no King, so she draws four and her turn ends. Play returns to Ann.

**4 — A King against a run**

Ann plays Red +2; Ben owes two. Ben plays the King: the run is cancelled, the colour is
still red, and Ben plays again — this time he may put down Blue 7, even though nothing
about it matches.

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

---

## עברית

### החבילה — 124 קלפים

| קלפים                                   | כמות      | סה"כ    |
| --------------------------------------- | --------- | ------- |
| מספרים 1–9, ארבעה צבעים, שניים מכל אחד  | 9 × 4 × 2 | 72      |
| עצור, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| פלוס, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| קח 2, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| שינוי כיוון, ארבעה צבעים, שניים מכל אחד | 4 × 2     | 8       |
| טאקי, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| שינוי צבע (ללא צבע)                     | —         | 4       |
| סופר טאקי (ללא צבע)                     | —         | 2       |
| מלך (ללא צבע)                           | —         | 2       |
| פלוס 3 (ללא צבע)                        | —         | 2       |
| שבירת פלוס 3 (ללא צבע)                  | —         | 2       |
| **סה"כ**                                |           | **124** |

הצבעים: **אדום, כחול, ירוק, צהוב**.

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
2. **מושכים מחבילת המשיכה** — קלף אחד כרגיל, או את כל קנס הקח־2 שנצבר.

קלף חוקי אם מתקיים אחד מאלה:

- הוא בצבע הנוכחי, או
- הוא באותו **סמל** כמו הקלף העליון — אותו מספר, או אותו סוג פעולה (עצור על עצור, קח 2 על
  קח 2, פלוס על פלוס וכן הלאה), או
- הוא קלף ללא צבע (שינוי צבע, סופר טאקי, מלך, פלוס 3), שתמיד חוקי.

**שבירת פלוס 3 לעולם אינה הנחה רגילה**: היא קיימת רק כתשובה לפלוס 3 פתוח, ובכל רגע אחר
המנוע דוחה אותה בקוד `noPlusThreeOpen`.

מהתאמת הסמלים נובע שעצור כחול חוקי על עצור אדום, וגם שכל קח 2 עונה לכל קח 2.

**משיכה מסיימת את התור.** קלף שנמשך עכשיו לא נכנס לשולחן באותו תור, גם אם הוא חוקי.

**הנחת הקלף האחרון מנצחת בסבב מיד.**

### קלפים מיוחדים

| קלף              | השפעה                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **עצור**         | השחקן הבא מפסיד את תורו. בשני שחקנים התור חוזר מיד אליך.                                       |
| **פלוס**         | חייבים להניח עוד קלף. מי שאין לו קלף חוקי מושך קלף והתור עובר. פלוס נוסף מחדש את החובה.        |
| **קח 2**         | השחקן הבא חייב שני קלפים — אלא אם יניח קח 2 משלו, שמעלה את הקנס בשניים ומעביר אותו הלאה.       |
| **שינוי כיוון**  | סדר המשחק מתהפך. בשני שחקנים התור עובר בכל מקרה ליריב.                                         |
| **שינוי צבע**    | אפשר להניח על כל קלף. בוחרים את הצבע הבא והתור עובר.                                           |
| **טאקי**         | פותח רצף בצבע של הקלף — ראו למטה.                                                              |
| **סופר טאקי**    | אפשר להניח על כל קלף. פותח רצף בצבע שכבר מוביל.                                                |
| **מלך**          | אפשר להניח על כל קלף, גם על קנס קח־2 פתוח. מבטל כל קנס וכל חובה, ואז נותן תור חופשי בלי התאמה. |
| **פלוס 3**       | כל שאר השחקנים מושכים שלושה קלפים — אלא אם מישהו שובר.                                         |
| **שבירת פלוס 3** | מונחת **שלא בתור**, רק כתשובה לפלוס 3. מי שהניח את הפלוס 3 מושך שלושה במקום, ואף אחד אחר לא.   |

כל עוד יש חובת פלוס פתוחה **חייבים להניח אם אפשר**: חבילת המשיכה חסומה, והמנוע דוחה משיכה
בקוד `mustPlayAfterPlus`. הקלף שחייבים להניח נבחן לפי כללי ההתאמה הרגילים, ולא חייב להיות
באותו צבע.

### רצפי קח 2

- הנחת **קח 2** קובעת קנס של שני קלפים ומעבירה את התור.
- מי שתורו יכול לענות ב**קח 2 בכל צבע**, שמעלה את הקנס לארבעה, אחר כך לשישה וכן הלאה. הצבע
  המוביל הוא של הקח 2 האחרון שהונח.
- גם **מלך** עונה לקנס, ומוחק אותו לגמרי.
- שום דבר אחר לא חוקי כשקנס פתוח: המנוע דוחה כל קלף אחר בקוד `mustAnswerDraw`.
- מי שלא יכול או לא רוצה לענות **מושך את כל הקנס בבת אחת** ומפסיד את תורו.
- קח 2 שהונח **בתוך** רצף טאקי לא עושה דבר עד שהרצף נסגר; אם הוא הקלף האחרון, נפתח קנס
  כרגיל.

### המלך

המלך הוא התשובה להכול:

1. מניחים אותו על כל קלף עליון, בכל שלב בתור, כולל מול קנס קח־2 פתוח.
2. כל קנס קח־2 וכל חובת פלוס מתבטלים.
3. הצבע המוביל לא משתנה.
4. משחקים שוב, ובתור החופשי הזה **כל קלף ביד חוקי** — אין התאמת צבע או סמל. ההנחה קובעת את
   הצבע כרגיל.
5. יד ריקה בשלב הזה כבר הייתה ניצחון, כך שאין מצב תקוע.

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

**אף פעם לא מפרסמים מי מחזיק שבירה.** מצב השולחן הציבורי אומר רק שפלוס 3 פתוח ומי הניח
אותו; רשימת הממתינים נשארת אצל המנחה. כל לקוח מסיק אם הוא יכול לענות מהיד שלו, שאותה הוא
כבר יודע.

### רצפי טאקי

- הנחת קלף **טאקי** פותחת רצף שנעול לצבע של אותו קלף.
- כל עוד הרצף פתוח אפשר להניח **כמה קלפים שרוצים באותו צבע**, כולל קלפים מיוחדים וקלפי
  טאקי נוספים.
- **קלפים ללא צבע לא נכנסים לרצף.** שינוי צבע, סופר טאקי, מלך, פלוס 3 ושבירת פלוס 3 נדחים
  בקוד `wildNotAllowedInTaki`.
- קלף בצבע אחר נדחה בקוד `wrongTakiColor`, גם אם הסמל שלו מתאים לקלף העליון. בתוך רצף,
  הצבע הוא הכלל היחיד.
- **אי אפשר למשוך קלף כשרצף פתוח.** קודם סוגרים אותו (`cannotDrawDuringTaki`).
- סוגרים את הרצף בכפתור **סגירת טאקי**. אפשר לסגור בכל רגע, וחייבים לסגור כשנגמרו הקלפים
  באותו צבע.
- **כשהרצף נסגר חלה רק ההשפעה של הקלף האחרון שהונח.** לקלפים שהונחו לפניו אין השפעה כלל:
  - קלף אחרון מספר או טאקי → התור עובר כרגיל;
  - קלף אחרון **עצור** → השחקן הבא מדלג;
  - קלף אחרון **פלוס** → חייבים להניח עוד קלף, מחוץ לרצף ולפי ההתאמה הרגילה;
  - קלף אחרון **קח 2** → נפתח קנס של שניים מול השחקן הבא;
  - קלף אחרון **שינוי כיוון** → הכיוון מתהפך ואז התור עובר.
- מי שנגמרו לו הקלפים בתוך רצף מנצח מיד.

### סופר טאקי

סופר טאקי הוא טאקי ללא צבע שמקבל את הצבע שכבר במשחק:

1. מניחים אותו על כל קלף.
2. נפתח רצף ב**צבע הנוכחי**. לא בוחרים צבע, וניסיון לבחור נדחה ב-`colorNotAllowed`.
3. משם הרצף מתנהג בדיוק כמו רצף טאקי: רק אותו צבע, בלי קלפים ללא צבע, סגירה מפורשת,
   והשפעת הקלף האחרון בסגירה.
4. אם סוגרים כשהסופר טאקי עדיין הקלף העליון, התור פשוט עובר והצבע לא משתנה.

### סדר ההשפעות בהנחת קלף

1. הקלף יוצא מהיד ועולה על הערמה.
2. הצבע הנוכחי הופך לצבע הקלף, לצבע שנבחר בשינוי צבע, או נשאר כפי שהיה בכל קלף אחר ללא
   צבע.
3. **בדיקת ניצחון:** היד ריקה → הסבב נגמר בניצחון, ושום דבר אחר לא חל.
4. אם הקלף היה שבירת פלוס 3 → הפלוס 3 הפתוח מסתדר והתור ממשיך.
5. אם רצף פתוח → הקלף רק מצטרף לרצף, ואף השפעה לא חלה עדיין.
6. אחרת, אם הקלף טאקי או סופר טאקי → נפתח רצף והתור נשאר אצלך.
7. אחרת, ההשפעה של הקלף חלה (דילוג / קלף נוסף / קנס / היפוך כיוון / ביטול / העברת תור).

### כשנגמרים הקלפים למשיכה

כשחבילת המשיכה ריקה ומישהו חייב למשוך, כל הערמה **חוץ מהקלף העליון הגלוי** מעורבבת חזרה
לחבילת המשיכה, באותו מחולל אקראי עם זרע. הקלף העליון נשאר גלוי כדי לשמור על הצבע והסמל
שבמשחק, ואף קלף לא נעלם — יש בדיקה שמאמתת שכל מזהי הקלפים נשמרים.

אם באמת לא נשאר מה למשוך, התור פשוט עובר. אף שחקן לא נתקע.

### סוף הסבב

- השחקן הראשון שנשאר בלי קלפים מנצח.
- הטבלה המסכמת מציגה את כולם לפי מספר הקלפים שנשארו, מהמעט לרב; תוצאות שוות חולקות מקום.
- אין ניקוד בנקודות. כל משחק הוא סבב אחד.
- **סבב נוסף** מתחיל כשכל השחקנים המחוברים מסכימים. מי שלא חזר מנותק מהחלוקה החדשה. שום
  דבר לא נשמר בין סבבים חוץ מסדר המושבים.

### התנהגות בשני שחקנים

| קלף             | בשני שחקנים                                                         |
| --------------- | ------------------------------------------------------------------- |
| **עצור**        | מדלג על היריב, כך שהתור חוזר אליך — בפועל תור נוסף.                 |
| **שינוי כיוון** | דגל הכיוון מתהפך, אבל התור עובר בכל מקרה ליריב. אין לו השפעה מעשית. |
| **פלוס**        | בלי שינוי: משחקים שוב.                                              |
| **פלוס 3**      | היריב היחיד מושך שלושה, או שובר ומעביר את השלושה אליך.              |

### החלטות שקיבלנו במקומות שהמהדורות חולקות

| שאלה                                   | ההחלטה                                           | הנימוק                                                               |
| -------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| האם קלף שנמשך עכשיו אפשר להניח מיד?    | **לא.** משיכה מסיימת את התור.                    | הכי פשוט להסביר ולראות על המסך.                                      |
| האם סופר טאקי משנה צבע?                | **לא.** הוא מקבל את הצבע המוביל.                 | הקריאה שנכנסה עם קלף המלך, וזו שבמהדורה הנוכחית.                     |
| האם פלוס 3 משנה צבע?                   | **לא.**                                          | אותו עיקרון: רק שינוי צבע צובע מחדש את השולחן.                       |
| מי יכול לענות לפלוס 3, ומתי?           | **כל מחזיק שבירה, שלא בתור**, עד לתשובה הראשונה. | זה כל הרעיון של הקלף; הגבלה לשחקן הבא הייתה הופכת אותו לקלף רגיל.    |
| שינוי כיוון בשני שחקנים                | **התור עובר ליריב.**                             | נובע ישירות מחישוב השחקן הבא, בלי מקרה מיוחד.                        |
| ניצחון בקלף פלוס, קח 2, פלוס 3 או טאקי | **מנצחים.** כל חובה שנותרה מתבטלת.               | יד ריקה מסיימת את הסבב; דרישה לקלף נוסף מיד ריקה חסרת משמעות.        |
| קלפים ללא צבע בתוך רצף                 | **אסור.**                                        | רצף מוגדר על ידי צבע, ולקלף ללא צבע אין.                             |
| אילו השפעות חלות בסגירת רצף?           | **רק של הקלף האחרון.**                           | אחרת רצף ארוך היה משרשר כמה קלפי עצור.                               |
| האם קנס קח־2 מצטבר?                    | **כן, בשניים לכל קלף, בלי תקרה.**                | זה החוק המודפס, והמלך הוא שסתום השחרור.                              |
| הכרזה על "קלף אחרון" וקנס על שתיקה     | **לא מיושם.**                                    | אכיפה הוגנת דורשת חוק תזמון שלא רצינו להמציא. מספר הקלפים תמיד גלוי. |
| קלף פתיחה מיוחד                        | **עובר לתחתית החבילה** עד שנשלף קלף מספר.        | שומר על תור ראשון חד־משמעי בלי לזרוק קלפים.                          |
| ניקוד                                  | **אין.** הטבלה מציגה קלפים שנשארו.               | שיטות הניקוד משתנות מאוד; מספר קלפים חד־משמעי.                       |

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
קח 2 ואין מלך, ולכן היא מושכת ארבעה ותורה נגמר. התור חוזר לאן.

**4 — מלך מול קנס**

אן מניחה קח 2 אדום; בן חייב שניים. בן מניח מלך: הקנס מתבטל, הצבע נשאר אדום, ובן משחק
שוב — והפעם הוא יכול להניח כחול 7, למרות ששום דבר בו לא מתאים.

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
