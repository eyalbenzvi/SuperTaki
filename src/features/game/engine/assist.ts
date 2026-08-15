/**
 * A thumb on the scale, and nowhere near the rules.
 *
 * A table with a six-year-old and a twelve-year-old at it is not a fair game and
 * cannot be made into one by playing fairly. The usual answers are all worse than
 * the problem: bending a rule for one player turns every round into an argument
 * about the bending, and letting somebody win on purpose is obvious to the person
 * it is done for, which is the one outcome that spoils the evening completely.
 *
 * So this bends *luck* instead. Every function here changes which card comes off a
 * shuffled pile, never what may be done with it: no penalty is smaller, no card is
 * legal that was not, no count anybody can see is different. What a marked seat
 * gets is the deal it might have got anyway, the draw it might have got anyway, and
 * a table that is a little slower to punish it — which is exactly the shape of a
 * lucky evening, because a lucky evening is what it is meant to look like.
 *
 * Three properties every function here keeps, and the tests hold all three:
 *
 * 1. **Cards are conserved.** Nothing is created, duplicated or dropped. Every bias
 *    is a permutation or a choice of index within a pile the caller already had.
 * 2. **No new randomness.** These are total functions of state the engine already
 *    holds, so a round still replays exactly, and turning the feature on does not
 *    advance the shuffle's stream by a single step.
 * 3. **Nought is nothing.** With no weight on any seat, every function returns what
 *    the caller would have done without it — the same hand, the same index, the same
 *    seat — so an unmarked table is not merely fair but *identical*, byte for byte,
 *    to the game as it was before any of this existed.
 *
 * Who is marked is decided by the room and never travels in the broadcast every
 * player receives; see `docs/assist.md`.
 */

import { CARD_COLORS, cardColor, type Card, type CardColor } from './cards.ts';
import { isCardPlayable, type PlayContext } from './rules.ts';
import type { EnginePlayer, PlayerId } from './state.ts';

/**
 * How far the table leans, as one dial for the whole room.
 *
 * A dial rather than a number per child, because the question a person running a
 * table actually asks is "how much help is this evening", and answering it once for
 * everybody who is marked is both easier to hold in the head and harder to turn
 * into an accusation about who got more.
 */
export const ASSIST_LEVELS = ['off', 'light', 'medium', 'strong'] as const;
export type AssistLevel = (typeof ASSIST_LEVELS)[number];

export const MAX_ASSIST_WEIGHT = 3;

/** The dial, as the number every function below reads. `0` is an untouched game. */
export function assistWeight(level: AssistLevel): number {
  switch (level) {
    case 'off':
      return 0;
    case 'light':
      return 1;
    case 'medium':
      return 2;
    case 'strong':
      return MAX_ASSIST_WEIGHT;
  }
}

/**
 * How much the table leans towards each seat, keyed by player.
 *
 * Weights rather than the room's dial-plus-list, because the engine has no business
 * knowing that the two are related: it is handed a number per seat and biases by it.
 * An absent seat weighs nought, which is why an empty record is the whole of "this
 * table is playing the ordinary game".
 */
export type AssistWeights = Readonly<Record<PlayerId, number>>;

export const NO_ASSIST: AssistWeights = Object.freeze({});

/** This seat's weight, clamped into range. Total, so a malformed record cannot throw. */
export function assistFor(assist: AssistWeights, playerId: PlayerId): number {
  const weight = assist[playerId];
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(weight), 0), MAX_ASSIST_WEIGHT);
}

/** Whether any seat at all is marked. The early exit every caller takes. */
export function anyAssisted(assist: AssistWeights): boolean {
  return Object.values(assist).some((weight) => typeof weight === 'number' && weight > 0);
}

/** Marked seats, heaviest first and then in seat order, so first pick is deterministic. */
export function assistedSeats(players: readonly EnginePlayer[], assist: AssistWeights): number[] {
  return players
    .map((player, index) => ({ index, weight: assistFor(assist, player.id) }))
    .filter((seat) => seat.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((seat) => seat.index);
}

/**
 * What one card is worth, in the abstract.
 *
 * Deliberately the same scale for a hand being dealt and a card being drawn, and
 * deliberately *not* the robot's `scoreCard`: that one answers "which of these
 * should I play now", which is a question about the table. This one answers "is this
 * a card I would like to be holding", which is a question about the card. They
 * disagree on purpose — a Change Colour is the last thing a robot spends and among
 * the first things anybody wants to have.
 */
const CARD_WORTH: Readonly<Record<Card['kind'], number>> = {
  number: 1,
  direction: 2,
  plus: 2,
  /*
   * A breaker is worth having and worth little: it answers exactly one card, and
   * played at any other moment it costs its owner three. Above a number, below
   * everything that can be spent on an ordinary turn.
   */
  breakPlusThree: 3,
  stop: 3,
  taki: 4,
  plusTwo: 4,
  superTaki: 5,
  king: 5,
  colorChange: 5,
  plusThree: 6,
};

function colorCounts(cards: readonly Card[]): Record<CardColor, number> {
  const counts: Record<CardColor, number> = { red: 0, blue: 0, green: 0, yellow: 0 };
  for (const card of cards) {
    const color = cardColor(card);
    if (color !== null) {
      counts[color] += 1;
    }
  }
  return counts;
}

/**
 * The colour these cards lean on, or `fallback` when they lean on none.
 *
 * Ties go to the first colour in the deck's own order rather than to whichever the
 * shuffle happened to put first, because every function here has to give the same
 * answer twice for a replay to be a replay.
 */
export function dominantColor(cards: readonly Card[], fallback: CardColor): CardColor {
  const counts = colorCounts(cards);
  let best = fallback;
  let bestCount = 0;
  for (const color of CARD_COLORS) {
    if (counts[color] > bestCount) {
      best = color;
      bestCount = counts[color];
    }
  }
  return best;
}

/**
 * How good a hand is to be dealt.
 *
 * Two things make a Taki hand: what it can do to other people, and how much of it
 * is one colour. The first is the sum of the cards; the second is worth counting
 * twice over when the hand also holds the Taki that would spend the whole run in a
 * single turn, which is the play that wins rounds and the one a child remembers.
 */
export function handStrength(hand: readonly Card[]): number {
  let total = 0;
  for (const card of hand) {
    total += CARD_WORTH[card.kind];
  }
  const counts = colorCounts(hand);
  const leading = dominantColor(hand, CARD_COLORS[0]);
  const longest = counts[leading];
  total += longest;
  if (hand.some((card) => card.kind === 'taki' && card.color === leading)) {
    total += longest;
  }
  return total;
}

/**
 * Hands as dealt, redistributed so the marked seats get the best of them.
 *
 * The whole method, and the reason it is first: it is a *permutation*. The shuffle
 * is untouched, the deal is untouched, the draw pile is untouched, and every card
 * that was going to be somebody's is still somebody's — only the somebody changes.
 * There is nothing here for anybody to notice, because there is nothing here that a
 * differently-seeded evening would not have produced by itself.
 *
 * Marked seats take the strongest hands in weight order. The rest keep what is left
 * *in the order it was dealt*, so an unmarked seat is not additionally sorted
 * against: it holds the hand it would have held, minus whatever went to a child.
 * Which is the honest description of the trade, and the reason a table where
 * everybody is marked is left alone entirely — a lean everybody shares is not a
 * lean, and pretending otherwise would just be a slower shuffle.
 */
export function assignHands(
  dealt: readonly (readonly Card[])[],
  players: readonly EnginePlayer[],
  assist: AssistWeights,
): readonly (readonly Card[])[] {
  const favoured = assistedSeats(players, assist);
  if (favoured.length === 0 || favoured.length >= players.length) {
    return dealt;
  }
  const ranked = dealt
    .map((hand, index) => ({ index, strength: handStrength(hand) }))
    .sort((a, b) => b.strength - a.strength || a.index - b.index)
    .map((entry) => entry.index);

  const result: (readonly Card[])[] = new Array<readonly Card[]>(dealt.length);
  const claimed = new Set<number>();
  favoured.forEach((seat, pick) => {
    const from = ranked[pick] as number;
    claimed.add(from);
    result[seat] = dealt[from] as readonly Card[];
  });
  const remaining = ranked.filter((index) => !claimed.has(index)).sort((a, b) => a - b);
  let next = 0;
  for (let seat = 0; seat < dealt.length; seat += 1) {
    if (result[seat] === undefined) {
      result[seat] = dealt[remaining[next] as number] as readonly Card[];
      next += 1;
    }
  }
  return result;
}

/**
 * How many cards deep a marked seat may look before taking one.
 *
 * One is no look at all — the top card, as always. The window is what makes the
 * dial mean anything at a draw: two is a coin the table is holding for you, five is
 * a seat that almost always draws something it can use. Nobody can see the order of
 * a face-down pile, so this is the least visible of every method here and the one
 * that carries the most weight — including on the draws that matter most, which are
 * the penalties.
 */
export function drawWindow(weight: number): number {
  switch (Math.min(Math.max(Math.trunc(weight), 0), MAX_ASSIST_WEIGHT)) {
    case 1:
      return 2;
    case 2:
      return 3;
    case MAX_ASSIST_WEIGHT:
      return 5;
    default:
      return 1;
  }
}

/**
 * What this card is worth to this hand, right now.
 *
 * A card you can put straight back down is worth more than a better card you
 * cannot, which is most of the mercy in this file: a child who draws and then plays
 * has had a turn, and a child who draws and passes has had a punishment.
 *
 * Playability is judged as if nothing were owed. During a +2 run only a +2 or a
 * King is legal, so asking the literal question would score every card the same and
 * throw the window away on exactly the turn — an eight-card run being paid — where
 * a good card matters most. What the seat needs then is a card for the turn *after*
 * the payment, and that is the question this asks.
 */
export function drawValue(card: Card, hand: readonly Card[], context: PlayContext): number {
  let value = CARD_WORTH[card.kind];
  if (isCardPlayable(card, { ...context, pendingDraw: 0 })) {
    value += 6;
  }
  const color = cardColor(card);
  if (color !== null && color === dominantColor(hand, context.activeColor)) {
    value += 2;
  }
  return value;
}

/**
 * Which card to lift out of the pile, counting from the top.
 *
 * `0` for an unmarked seat, always and without looking at anything, which is what
 * keeps an ordinary game an ordinary game. Ties go to the shallower card so the
 * pile is disturbed as little as the choice allows.
 */
export function chooseDrawIndex(
  pile: readonly Card[],
  weight: number,
  hand: readonly Card[],
  context: PlayContext,
): number {
  const window = Math.min(drawWindow(weight), pile.length);
  if (window <= 1) {
    return 0;
  }
  let best = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < window; index += 1) {
    const value = drawValue(pile[index] as Card, hand, context);
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  }
  return best;
}

/**
 * A freshly shuffled pile, with the beneficiary's best cards brought to the top.
 *
 * The one method that is nearly free, because the shuffle it biases has already
 * happened: a recycle is the discard pile turned over, and which end of it a
 * marked seat meets first is not a fact any player has access to. It matters
 * because a recycle lands mid-penalty as often as not — the pile runs out precisely
 * when somebody is drawing four — and the window above can only choose from what is
 * near the top.
 *
 * Cards are moved, never copied: the result is a permutation of its input, and the
 * test that says so is the same one that guards the deal.
 */
export function frontLoadForDraw(
  pile: readonly Card[],
  weight: number,
  hand: readonly Card[],
  context: PlayContext,
): readonly Card[] {
  const lift = Math.min(drawWindow(weight), pile.length);
  if (lift <= 1) {
    return pile;
  }
  const ranked = pile
    .map((card, index) => ({ index, value: drawValue(card, hand, context) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, lift)
    .map((entry) => entry.index);
  const lifted = new Set(ranked);
  return [...ranked.map((index) => pile[index] as Card), ...pile.filter((_, index) => !lifted.has(index))];
}

/**
 * The colour the opening card should be, or `null` when nobody is marked.
 *
 * The heaviest marked seat's own colour, so the first turn of the round comes round
 * to a hand that has something to answer with. Worth almost nothing on its own and
 * costing almost nothing to have: the engine is already walking the pile looking for
 * a number card, and this only makes it fussier about which one it stops on.
 */
export function preferredOpeningColor(
  hands: Readonly<Record<PlayerId, readonly Card[]>>,
  players: readonly EnginePlayer[],
  assist: AssistWeights,
): CardColor | null {
  const favoured = assistedSeats(players, assist);
  if (favoured.length === 0 || favoured.length >= players.length) {
    return null;
  }
  const seat = players[favoured[0] as number] as EnginePlayer;
  const hand = hands[seat.id] ?? [];
  if (hand.length === 0) {
    return null;
  }
  return dominantColor(hand, CARD_COLORS[0]);
}

/**
 * How far the engine will dig for an opening card of the preferred colour.
 *
 * Bounded because the alternative is not bounded: a preference with no budget would
 * bury a quarter of the deck on an unlucky pile, and every card it buried would be
 * one the table then draws in an order somebody chose. Past the budget the engine
 * takes the first number card it meets, exactly as it always did.
 */
export const OPENING_SCAN_LIMIT = 12;

/**
 * Which seat opens the round.
 *
 * The rotation is left alone on even rounds and handed to a marked seat on odd
 * ones, which over an evening gives a child roughly half the openings at a table of
 * four rather than a quarter. Every other round rather than every round on purpose:
 * "you always start" is the one form of help at this table that a person notices
 * from the other side of it.
 *
 * The rotation itself still advances underneath, so the unmarked seats keep taking
 * their turns at opening in the order they always did — they simply take them on
 * the even rounds.
 */
export function biasedStartIndex(
  players: readonly EnginePlayer[],
  assist: AssistWeights,
  round: number,
  fallback: number,
): number {
  if (!Number.isFinite(round) || Math.trunc(round) % 2 === 0) {
    return fallback;
  }
  const favoured = assistedSeats(players, assist);
  if (favoured.length === 0 || favoured.length >= players.length) {
    return fallback;
  }
  const step = Math.floor(Math.abs(Math.trunc(round)) / 2) % favoured.length;
  return favoured[step] as number;
}
