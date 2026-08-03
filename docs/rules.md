# Rules of Color Rush / חוקי קולור ראש

These are the **exact** rules the engine implements. Where the wider family of
colour-matching shedding games disagrees between variants, one interpretation was chosen,
documented here, and covered by tests. The in-app rules page (`Rules` in the top bar) shows
the same content in Hebrew and English.

Every rule below corresponds to at least one unit test in `tests/unit/engine/`.

---

## English

### The deck — 110 cards

| Cards                                       | Count     | Total   |
| ------------------------------------------- | --------- | ------- |
| Numbers 1–9, four colours, two of each      | 9 × 4 × 2 | 72      |
| Stop, four colours, two of each             | 4 × 2     | 8       |
| Plus, four colours, two of each             | 4 × 2     | 8       |
| Change Direction, four colours, two of each | 4 × 2     | 8       |
| Taki, four colours, two of each             | 4 × 2     | 8       |
| Colour Change (no colour)                   | —         | 4       |
| Super Taki (no colour)                      | —         | 2       |
| **Deck total**                              |           | **110** |

Colours: **red, blue, green, yellow**.

There is **no King card and no Plus-3 / Break-Plus card** in this ruleset. Those exist in some
editions of the genre; they are not implemented here, so they are not claimed.

### Setup

- 2 to 6 players. Seats keep the order in which players joined, and that order is visible to
  everyone.
- The deck is shuffled with a seeded PRNG, so a given seed always deals the same game.
- Each player is dealt **8 cards**.
- The opening card is the **first number card** taken from the top of the shuffled deck. Any
  special card met on the way is moved to the **bottom** of the draw pile, so no card is
  wasted and the first turn is never ambiguous.
- The player in seat 1 (the host) starts. Play begins in the "forwards" direction.

### A turn

On your turn you do exactly one of:

1. **Play a legal card**, or
2. **Draw one card from the draw pile.**

A card is legal when any of these holds:

- it matches the **current colour**, or
- it matches the **symbol** of the top card — the same number value, or the same action kind
  (Stop on Stop, Plus on Plus, Change Direction on Change Direction, Taki on Taki), or
- it is a **wild card** (Colour Change, Super Taki), which is always legal.

Note the consequence: a Blue Stop is legal on a Red Stop, because the _symbols_ match even
though the colours do not.

**Drawing ends your turn.** A card you just drew may not be played in the same turn, even if
it is legal. (Chosen for clarity; some variants allow it.)

**Playing your last card wins the round immediately.**

### Special cards

| Card                 | Effect                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Stop**             | The next player loses their turn. With two players the turn comes straight back to you.                                             |
| **Plus**             | You must play one more card. If you hold nothing legal, you draw one card and your turn ends. A second Plus repeats the obligation. |
| **Change Direction** | The play order reverses. With two players the turn still passes to your opponent.                                                   |
| **Colour Change**    | Playable on anything. You choose the next colour, and your turn ends.                                                               |
| **Taki**             | Opens a sequence in that card's colour — see below.                                                                                 |
| **Super Taki**       | Playable on anything. You choose a colour and open a sequence in it.                                                                |

While a Plus obligation is outstanding you **must play if you can**: the draw pile is
disabled, and the engine rejects a draw with `mustPlayAfterPlus`. The card you owe follows
normal matching rules — it does not have to be the same colour as the Plus.

### Taki sequences

- Playing a **Taki** card opens a sequence locked to that card's colour.
- While the sequence is open you may play **any number of further cards of that colour**,
  including other special cards and further Taki cards.
- **Colourless cards cannot enter a sequence.** Colour Change and Super Taki have no colour,
  so the engine rejects them with `wildNotAllowedInTaki`.
- A card of a different colour is rejected with `wrongTakiColor`, even if its symbol matches
  the top card. Inside a sequence, colour is the only rule.
- **You cannot draw while a sequence is open.** Close it first (`cannotDrawDuringTaki`).
- Close the sequence with the explicit **Close Taki** button. You may close it at any time,
  and you must close it when you have no more cards of that colour.
- **When the sequence closes, only the effect of the last card played applies.** Cards played
  earlier in the sequence have no effect at all. So:
  - last card a number, or a Taki card → the turn passes normally;
  - last card **Stop** → the next player is skipped;
  - last card **Plus** → you must play one more card (outside the sequence, normal matching);
  - last card **Change Direction** → the order reverses, then the turn passes.
- Emptying your hand during a sequence wins immediately.

### Super Taki

Super Taki is a colourless Taki:

1. Play it on anything.
2. Choose a colour in the modal (also reachable by keyboard; each option has a distinct shape
   as well as a colour).
3. A sequence opens in the colour you chose, and the current colour becomes that colour.
4. From there it behaves exactly like a Taki sequence: same-colour cards only, no wild cards,
   explicit close, last-card effect on closing.
5. If you close the sequence with the Super Taki still the top card, the turn simply passes —
   the colour you chose stays in force.

Choosing no colour is impossible: the engine rejects the play with `colorRequired`, and an
invalid colour with `colorNotAllowed`.

### Effect order when a card is played

1. The card leaves your hand and goes on top of the discard pile.
2. The current colour becomes the card's colour, or your chosen colour for a wild card.
3. **Win check:** hand empty → the round ends, you win, nothing else resolves.
4. If a sequence is open → the card only joins the sequence; no effect resolves yet.
5. Otherwise, if the card is a Taki or Super Taki → a sequence opens; the turn stays with you.
6. Otherwise, the card's effect resolves (skip / extra card / reverse / pass).

### Running out of cards to draw

When the draw pile is empty and someone must draw, every card in the discard pile **except the
visible top card** is shuffled back into the draw pile, using the same seeded PRNG. The top
card stays face up so the colour and symbol in play are preserved, and no card is ever lost —
a test asserts the full set of card ids is conserved.

If there is genuinely nothing left to draw (an empty draw pile and only one discard), the turn
simply passes. No player is ever stuck.

### End of the round

- The first player to empty their hand wins.
- The final table lists everyone by remaining cards, fewest first; ties share a place.
- There is no point scoring. Each game is one round.
- **Play again** starts a new round when **every connected player agrees**. Players who never
  reconnected are dropped from the new deal. Nothing is saved between rounds beyond the
  seating.

### Two-player behaviour, stated explicitly

| Card                 | With 2 players                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Stop**             | Skips your opponent, so the turn returns to you — effectively an extra turn.                      |
| **Change Direction** | The direction flag flips, but the turn still passes to your opponent. It has no practical effect. |
| **Plus**             | Unchanged: you play again.                                                                        |

### Decisions we made where variants disagree

Each of these is a genuine fork in the wider genre. We picked one, implemented it, and tested
it.

| Question                                          | Our rule                                                                               | Why                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| May a card drawn this turn be played immediately? | **No.** Drawing ends the turn.                                                         | Simplest to explain and to see on screen; no "you could have played that" ambiguity.                                           |
| Change Direction with two players                 | **Turn passes to the opponent.**                                                       | Follows directly from the modular next-player calculation instead of adding a special case.                                    |
| Can you win on a Plus or a Taki card?             | **Yes.** The outstanding obligation is void.                                           | An empty hand ends the round; requiring a further card from an empty hand is incoherent.                                       |
| Wild cards inside a Taki sequence                 | **Not allowed.**                                                                       | A sequence is defined by a colour, and a wild card has none. Allowing it would let a player recolour mid-sequence.             |
| Which effects apply when a sequence closes?       | **Only the last card's.**                                                              | Otherwise a long sequence could chain several Stops, which no variant we know of intends.                                      |
| Stacking (passing an effect to the next player)   | **Not permitted.** Effects resolve immediately.                                        | This deck has no draw-two style card to stack; adding stacking would be an invention.                                          |
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

**3 — A Taki sequence with a trailing Plus**

Ann plays Red Taki, then Red Plus, then closes. The last card is a Plus, so Ann must play one
more card — outside the sequence, under normal matching. A Blue Plus would be legal (symbol
match); a Blue 2 would not.

**4 — Super Taki**

Current colour: red. Ann plays Super Taki and chooses green. A green sequence opens and the
current colour is now green. Ann may play Green 3 and Green Stop, but not Blue 3 (wrong
colour) and not Colour Change (colourless). She closes; the last card was Green Stop, so the
next player is skipped.

**5 — Plus with nothing legal**

Ben plays Red Plus and holds only Blue 4 and Blue 7. Neither matches red or the Plus symbol,
so he cannot satisfy the obligation: he draws one card and his turn ends.

**6 — Recycling**

The draw pile is empty and Cat must draw. The discard pile is Red 9, Red 2, Blue 2, Yellow 2
(Yellow 2 on top). Yellow 2 stays face up; the other three are shuffled back; Cat draws one of
them; two remain in the draw pile.

---

## עברית

### החבילה — 110 קלפים

| קלפים                                   | כמות      | סה"כ    |
| --------------------------------------- | --------- | ------- |
| מספרים 1–9, ארבעה צבעים, שניים מכל אחד  | 9 × 4 × 2 | 72      |
| עצור, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| פלוס, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| שינוי כיוון, ארבעה צבעים, שניים מכל אחד | 4 × 2     | 8       |
| טאקי, ארבעה צבעים, שניים מכל אחד        | 4 × 2     | 8       |
| שינוי צבע (ללא צבע)                     | —         | 4       |
| סופר טאקי (ללא צבע)                     | —         | 2       |
| **סה"כ**                                |           | **110** |

הצבעים: **אדום, כחול, ירוק, צהוב**. אין בחוקים האלה קלפי מלך ואין פלוס-3.

### התחלה

- 2 עד 6 שחקנים, לפי סדר ההצטרפות, וסדר המושבים גלוי לכולם.
- החבילה מעורבבת בעזרת מחולל מספרים אקראיים עם זרע, כך שאותו זרע מחלק בדיוק את אותו משחק.
- כל שחקן מקבל **8 קלפים**.
- קלף הפתיחה הוא **קלף המספר הראשון** מראש החבילה. כל קלף מיוחד שנשלף בדרך עובר לתחתית חבילת
  המשיכה, כך שאף קלף לא הולך לאיבוד והתור הראשון תמיד חד־משמעי.
- השחקן במושב הראשון (המנחה) מתחיל, בכיוון "קדימה".

### מהלך תור

בתור שלך עושים בדיוק אחד מהשניים:

1. **מניחים קלף חוקי**, או
2. **מושכים קלף אחד** מחבילת המשיכה.

קלף חוקי אם מתקיים אחד מאלה:

- הוא בצבע הנוכחי, או
- הוא באותו **סמל** כמו הקלף העליון — אותו מספר, או אותו סוג פעולה (עצור על עצור, פלוס על
  פלוס, שינוי כיוון על שינוי כיוון, טאקי על טאקי), או
- הוא קלף ללא צבע (שינוי צבע, סופר טאקי), שתמיד חוקי.

מכאן נובע שעצור כחול חוקי על עצור אדום, כי הסמלים זהים גם אם הצבעים שונים.

**משיכה מסיימת את התור.** קלף שנמשך עכשיו לא נכנס לשולחן באותו תור, גם אם הוא חוקי.

**הנחת הקלף האחרון מנצחת בסבב מיד.**

### קלפים מיוחדים

| קלף             | השפעה                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| **עצור**        | השחקן הבא מפסיד את תורו. בשני שחקנים התור חוזר מיד אליך.                                |
| **פלוס**        | חייבים להניח עוד קלף. מי שאין לו קלף חוקי מושך קלף והתור עובר. פלוס נוסף מחדש את החובה. |
| **שינוי כיוון** | סדר המשחק מתהפך. בשני שחקנים התור עובר בכל מקרה ליריב.                                  |
| **שינוי צבע**   | אפשר להניח על כל קלף. בוחרים את הצבע הבא והתור עובר.                                    |
| **טאקי**        | פותח רצף בצבע של הקלף — ראו למטה.                                                       |
| **סופר טאקי**   | אפשר להניח על כל קלף. בוחרים צבע ונפתח רצף בצבע הזה.                                    |

כל עוד יש חובת פלוס פתוחה **חייבים להניח אם אפשר**: חבילת המשיכה חסומה, והמנוע דוחה משיכה
בקוד `mustPlayAfterPlus`. הקלף שחייבים להניח נבחן לפי כללי ההתאמה הרגילים, ולא חייב להיות
באותו צבע.

### רצפי טאקי

- הנחת קלף **טאקי** פותחת רצף שנעול לצבע של אותו קלף.
- כל עוד הרצף פתוח אפשר להניח **כמה קלפים שרוצים באותו צבע**, כולל קלפים מיוחדים וקלפי טאקי
  נוספים.
- **קלפים ללא צבע לא נכנסים לרצף.** שינוי צבע וסופר טאקי נדחים בקוד `wildNotAllowedInTaki`.
- קלף בצבע אחר נדחה בקוד `wrongTakiColor`, גם אם הסמל שלו מתאים לקלף העליון. בתוך רצף, הצבע
  הוא הכלל היחיד.
- **אי אפשר למשוך קלף כשרצף פתוח.** קודם סוגרים אותו (`cannotDrawDuringTaki`).
- סוגרים את הרצף בכפתור **סגירת טאקי**. אפשר לסגור בכל רגע, וחייבים לסגור כשנגמרו הקלפים
  באותו צבע.
- **כשהרצף נסגר חלה רק ההשפעה של הקלף האחרון שהונח.** לקלפים שהונחו לפניו אין השפעה כלל:
  - קלף אחרון מספר או טאקי → התור עובר כרגיל;
  - קלף אחרון **עצור** → השחקן הבא מדלג;
  - קלף אחרון **פלוס** → חייבים להניח עוד קלף, מחוץ לרצף ולפי ההתאמה הרגילה;
  - קלף אחרון **שינוי כיוון** → הכיוון מתהפך ואז התור עובר.
- מי שנגמרו לו הקלפים בתוך רצף מנצח מיד.

### סופר טאקי

סופר טאקי הוא טאקי ללא צבע:

1. מניחים אותו על כל קלף.
2. בוחרים צבע בחלון הבחירה (נגיש גם מהמקלדת; לכל אפשרות יש צורה משלה ולא רק צבע).
3. נפתח רצף בצבע שנבחר, והצבע הנוכחי הופך לצבע הזה.
4. משם הרצף מתנהג בדיוק כמו רצף טאקי: רק אותו צבע, בלי קלפים ללא צבע, סגירה מפורשת, והשפעת
   הקלף האחרון בסגירה.
5. אם סוגרים כשהסופר טאקי עדיין הקלף העליון, התור פשוט עובר, והצבע שנבחר נשאר בתוקף.

אי אפשר להניח סופר טאקי בלי לבחור צבע: המנוע דוחה ב-`colorRequired`, וצבע לא חוקי ב-
`colorNotAllowed`.

### סדר ההשפעות בהנחת קלף

1. הקלף יוצא מהיד ועולה על הערמה.
2. הצבע הנוכחי הופך לצבע הקלף, או לצבע שנבחר בקלף ללא צבע.
3. **בדיקת ניצחון:** היד ריקה → הסבב נגמר בניצחון, ושום דבר אחר לא חל.
4. אם רצף פתוח → הקלף רק מצטרף לרצף, ואף השפעה לא חלה עדיין.
5. אחרת, אם הקלף טאקי או סופר טאקי → נפתח רצף והתור נשאר אצלך.
6. אחרת, ההשפעה של הקלף חלה (דילוג / קלף נוסף / היפוך כיוון / העברת תור).

### כשנגמרים הקלפים למשיכה

כשחבילת המשיכה ריקה ומישהו חייב למשוך, כל הערמה **חוץ מהקלף העליון הגלוי** מעורבבת חזרה
לחבילת המשיכה, באותו מחולל אקראי עם זרע. הקלף העליון נשאר גלוי כדי לשמור על הצבע והסמל
שבמשחק, ואף קלף לא נעלם — יש בדיקה שמאמתת שכל מזהי הקלפים נשמרים.

אם באמת לא נשאר מה למשוך, התור פשוט עובר. אף שחקן לא נתקע.

### סוף הסבב

- השחקן הראשון שנשאר בלי קלפים מנצח.
- הטבלה המסכמת מציגה את כולם לפי מספר הקלפים שנשארו, מהמעט לרב; תוצאות שוות חולקות מקום.
- אין ניקוד בנקודות. כל משחק הוא סבב אחד.
- **סבב נוסף** מתחיל כשכל השחקנים המחוברים מסכימים. מי שלא חזר מנותק מהחלוקה החדשה. שום דבר
  לא נשמר בין סבבים חוץ מסדר המושבים.

### התנהגות בשני שחקנים

| קלף             | בשני שחקנים                                                         |
| --------------- | ------------------------------------------------------------------- |
| **עצור**        | מדלג על היריב, כך שהתור חוזר אליך — בפועל תור נוסף.                 |
| **שינוי כיוון** | דגל הכיוון מתהפך, אבל התור עובר בכל מקרה ליריב. אין לו השפעה מעשית. |
| **פלוס**        | בלי שינוי: משחקים שוב.                                              |

### החלטות שקיבלנו במקומות שהווריאנטים חולקים

| שאלה                                | ההחלטה                                    | הנימוק                                                               |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| האם קלף שנמשך עכשיו אפשר להניח מיד? | **לא.** משיכה מסיימת את התור.             | הכי פשוט להסביר ולראות על המסך.                                      |
| שינוי כיוון בשני שחקנים             | **התור עובר ליריב.**                      | נובע ישירות מחישוב השחקן הבא, בלי מקרה מיוחד.                        |
| ניצחון בקלף פלוס או טאקי            | **מנצחים.** החובה שנותרה מתבטלת.          | יד ריקה מסיימת את הסבב; דרישה לקלף נוסף מיד ריקה חסרת משמעות.        |
| קלפים ללא צבע בתוך רצף              | **אסור.**                                 | רצף מוגדר על ידי צבע, ולקלף ללא צבע אין.                             |
| אילו השפעות חלות בסגירת רצף?        | **רק של הקלף האחרון.**                    | אחרת רצף ארוך היה משרשר כמה קלפי עצור.                               |
| הערמה (העברת השפעה לשחקן הבא)       | **אסורה.** ההשפעה חלה מיד.                | אין בחבילה קלף שמזמין הערמה; להוסיף אותה זו המצאה.                   |
| הכרזה על "קלף אחרון" וקנס על שתיקה  | **לא מיושם.**                             | אכיפה הוגנת דורשת חוק תזמון שלא רצינו להמציא. מספר הקלפים תמיד גלוי. |
| קלף פתיחה מיוחד                     | **עובר לתחתית החבילה** עד שנשלף קלף מספר. | שומר על תור ראשון חד־משמעי בלי לזרוק קלפים.                          |
| ניקוד                               | **אין.** הטבלה מציגה קלפים שנשארו.        | שיטות הניקוד משתנות מאוד; מספר קלפים חד־משמעי.                       |

### דוגמאות

**1 — התאמה לפי סמל בין צבעים**

הקלף העליון: עצור אדום. הצבע הנוכחי: אדום. ביד יש עצור ירוק וירוק 4.
עצור ירוק חוקי (אותו סמל); ירוק 4 לא (צבע לא מתאים, סמל לא מתאים).

**2 — רצף טאקי שמסתיים בעצור, שלושה שחקנים (אן → בן → קת)**

אן מניחה טאקי אדום → נפתח רצף אדום, התור נשאר אצלה.
אן מניחה אדום 3 → מצטרף לרצף, שום דבר לא חל.
אן מניחה עצור אדום → מצטרף לרצף, עדיין שום דבר לא חל.
אן לוחצת **סגירת טאקי** → הקלף האחרון היה עצור, לכן **בן מדלג** והתור עובר ל**קת**.

**3 — רצף שמסתיים בפלוס**

אן מניחה טאקי אדום, אחר כך פלוס אדום, וסוגרת. הקלף האחרון פלוס, לכן אן חייבת להניח עוד קלף —
מחוץ לרצף, לפי ההתאמה הרגילה. פלוס כחול יהיה חוקי (התאמת סמל); כחול 2 לא.

**4 — סופר טאקי**

הצבע הנוכחי אדום. אן מניחה סופר טאקי ובוחרת ירוק. נפתח רצף ירוק והצבע הנוכחי הופך לירוק. אן
יכולה להניח ירוק 3 ועצור ירוק, אבל לא כחול 3 (צבע לא מתאים) ולא שינוי צבע (ללא צבע). היא
סוגרת; הקלף האחרון היה עצור ירוק, לכן השחקן הבא מדלג.

**5 — פלוס בלי קלף חוקי**

בן מניח פלוס אדום ונשארו לו רק כחול 4 וכחול 7. אף אחד מהם לא מתאים לאדום ולא לסמל פלוס, ולכן
הוא לא יכול לקיים את החובה: הוא מושך קלף והתור עובר.

**6 — עירוב מחדש**

חבילת המשיכה ריקה וקת חייבת למשוך. בערמה יש אדום 9, אדום 2, כחול 2, צהוב 2 (צהוב 2 למעלה).
צהוב 2 נשאר גלוי; שלושת האחרים מעורבבים חזרה; קת מושכת אחד מהם; שניים נשארים בחבילה.
