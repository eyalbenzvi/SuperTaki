import { CARD_COLORS, cardColor, type Card, type CardColor } from '../engine/cards.ts';
import { isCardPlayable } from '../engine/rules.ts';
import { playContextFromPublic, type PublicGameState } from '../engine/views.ts';
/*
 * The *wire* action type on purpose.
 *
 * A robot may therefore express exactly what a remote player can express, and
 * nothing more: `skipTurn`, `leaveGame` and `abandonRound` are host-only commands
 * and are unreachable from here by construction — the same guarantee the protocol
 * gives a human client. Types only, so this module has no runtime dependency on
 * the network layer.
 */
import type { GameAction } from '../network/protocol.ts';
import type { BotView } from './view.ts';

/**
 * The robot's brain: one pure function of {@link BotView} plus injected randomness.
 *
 * No clocks, no `Math.random()`, no access to the authoritative state. That is
 * what makes it exactly as testable as the engine, and what makes "a robot cannot
 * see your hand" checkable rather than promised.
 *
 * It plays like a competent club player, not like an oracle. Every legality
 * decision goes through the same {@link isCardPlayable} the table's own UI uses, it
 * never reasons about cards it has not seen, it does not count the discard pile to
 * infer anybody's hand, and it can be caught on its own last card — the pause
 * before it declares lives in the driver precisely so a human can beat it to the
 * call.
 */

/** Which obligation a move answers. The driver's pause depends on it. */
export type BotMoveKind = 'breaker' | 'declare' | 'turn' | 'catch';

export interface BotMove {
  readonly action: GameAction;
  readonly kind: BotMoveKind;
  /** Set while the move continues an open Taki sequence, which is played briskly. */
  readonly inSequence?: boolean;
}

/**
 * Order in which cards are spent inside an open Taki sequence.
 *
 * Only the *last* card of a sequence has an effect, so the useful ones are kept
 * for the end: numbers and further Takis go down first, and the sequence closes on
 * the most punishing card the hand holds.
 */
const SEQUENCE_ORDER: Readonly<Record<Card['kind'], number>> = {
  number: 0,
  taki: 1,
  direction: 2,
  plus: 3,
  stop: 4,
  plusTwo: 5,
  // Colourless cards can never enter a sequence; listed so the record is total.
  colorChange: 9,
  superTaki: 9,
  king: 9,
  plusThree: 9,
  breakPlusThree: 9,
};

function colorCounts(hand: readonly Card[]): Record<CardColor, number> {
  const counts: Record<CardColor, number> = { red: 0, blue: 0, green: 0, yellow: 0 };
  for (const card of hand) {
    const color = cardColor(card);
    if (color !== null) {
      counts[color] += 1;
    }
  }
  return counts;
}

/**
 * The colour this hand is strongest in, or `fallback` when it holds none.
 *
 * Total on purpose: it names the colour for a Change Colour, and the engine
 * *requires* one — a hand of nothing but colourless cards would otherwise produce
 * a `colorRequired` rejection on what may be a winning card.
 */
function dominantColor(hand: readonly Card[], fallback: CardColor): CardColor {
  const counts = colorCounts(hand);
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

function activeSeatCount(table: PublicGameState): number {
  return table.players.filter((player) => player.left !== true).length;
}

/** How many cards the seat that would move next is holding. */
function nextPlayerCardCount(table: PublicGameState): number {
  const players = table.players;
  const index = players.findIndex((player) => player.id === table.currentPlayerId);
  if (index < 0) {
    return Number.POSITIVE_INFINITY;
  }
  for (let step = 1; step <= players.length; step += 1) {
    const at = (((index + step * table.direction) % players.length) + players.length) % players.length;
    const candidate = players[at];
    if (candidate && candidate.left !== true && candidate.id !== table.currentPlayerId) {
      return candidate.cardCount;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * How much the robot wants to play this card on an open turn. Higher is better.
 *
 * The shape of the table matters as much as the card: a +2 is worth more against
 * somebody sitting on two cards, and a Taki is worth exactly as much as the colour
 * behind it is long.
 */
function scoreCard(card: Card, view: BotView): number {
  const { table, hand } = view;
  const counts = colorCounts(hand);
  const pressure = nextPlayerCardCount(table) <= 3;

  switch (card.kind) {
    case 'plusThree':
      // Every other seat draws three unless somebody answers with a breaker.
      return 9;
    case 'plusTwo':
      return pressure ? 8 : 7;
    case 'stop':
      // With two players a Stop comes straight back round: it is an extra turn,
      // not a way of picking on the next seat.
      return activeSeatCount(table) === 2 ? 8 : pressure ? 7 : 5;
    case 'taki': {
      // A sequence is worth what follows it: every other card of that colour.
      const followers = Math.max(counts[card.color] - 1, 0);
      return 6 + Math.min(followers, 4);
    }
    case 'superTaki': {
      // The same, in the colour already leading — minus a point for spending a
      // colourless card that could have opened a sequence at a better moment.
      return 4 + Math.min(counts[table.activeColor], 4);
    }
    case 'plus': {
      /*
       * A Plus is worth having something to pay it with. The card it demands has
       * to match the Plus's own colour or be colourless, and it may also be paid
       * from the draw pile — so a Plus with nothing behind it is not a loss, just
       * a turn spent going nowhere.
       */
      const followUp = hand.some(
        (candidate) =>
          candidate.id !== card.id && (cardColor(candidate) === card.color || cardColor(candidate) === null),
      );
      return followUp ? 6 : 3;
    }
    case 'number':
      // Leaving the table in the colour this hand is strongest in makes the next
      // turn easier, whenever it comes back round.
      return counts[card.color] >= counts[dominantColor(hand, card.color)] ? 5 : 4;
    case 'direction':
      return 3;
    case 'king':
      // Hoarded: its value is cancelling somebody else's +2 run. When it is the
      // only legal card it still wins this comparison.
      return 2;
    case 'colorChange':
      // Hoarded for the same reason: it is the one card that is always playable.
      return 1;
    case 'breakPlusThree':
      /*
       * Never spent outside a +3 window. Its three cards are drawn *before* the
       * win check, so it cannot even be a way out of a last card — and drawing one
       * card from the pile is strictly cheaper than drawing three. Callers filter
       * it out, so this score is only a backstop.
       */
      return -1;
  }
}

function play(card: Card, chosenColor?: CardColor): GameAction {
  return chosenColor === undefined
    ? { type: 'playCard', cardId: card.id }
    : { type: 'playCard', cardId: card.id, chosenColor };
}

/**
 * Turns a chosen card into an action, naming a colour exactly when the card
 * demands one: the engine rejects a missing choice and an unasked-for one alike.
 */
function playChoice(card: Card, view: BotView): GameAction {
  if (card.kind !== 'colorChange') {
    return play(card);
  }
  const rest = view.hand.filter((candidate) => candidate.id !== card.id);
  return play(card, dominantColor(rest, view.table.activeColor));
}

/** Cards that may be played right now, minus the one the robot never spends. */
function candidates(view: BotView): Card[] {
  const context = playContextFromPublic(view.table);
  return view.hand.filter((card) => card.kind !== 'breakPlusThree' && isCardPlayable(card, context));
}

/** Picks one of the joint-best cards, so two robots do not play in lockstep. */
function pickBest(cards: readonly Card[], view: BotView, random: () => number): Card {
  let best: Card[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const score = scoreCard(card, view);
    if (score > bestScore) {
      bestScore = score;
      best = [card];
    } else if (score === bestScore) {
      best.push(card);
    }
  }
  const index = Math.min(Math.floor(random() * best.length), best.length - 1);
  return best[index] as Card;
}

/**
 * Continues or closes an open sequence of the robot's own.
 *
 * A sequence is defined by its colour and nothing inside it repaints the table — a
 * further Taki included — so the only question is which of the remaining cards of
 * that colour goes down next, and the answer is: the least useful one, because only
 * the card the sequence closes on has an effect.
 */
function sequenceAction(view: BotView): GameAction {
  const { hand } = view;
  const context = playContextFromPublic(view.table);
  const legal = hand.filter((card) => isCardPlayable(card, context));
  if (legal.length === 0) {
    // Nothing of the sequence colour left, so closing is the only move — and the
    // card already on top resolves as the sequence's effect.
    return { type: 'closeTaki' };
  }
  if (hand.length === 1) {
    // Emptying the hand inside a sequence wins immediately.
    return play(legal[0] as Card);
  }
  const ordered = legal
    .slice()
    .sort((a, b) => SEQUENCE_ORDER[a.kind] - SEQUENCE_ORDER[b.kind] || a.id.localeCompare(b.id));
  return play(ordered[0] as Card);
}

/**
 * What to do with a turn. Always an action.
 *
 * A turn a robot declined to take would freeze the table, so every branch ends in
 * a card, a close, or the draw pile — which is legal on every turn but one, and
 * that one (an open sequence) is handled above it.
 */
function turnAction(view: BotView, random: () => number): GameAction {
  const taki = view.table.takiMode;
  if (taki !== null && taki.playerId === view.playerId) {
    return sequenceAction(view);
  }

  const playable = candidates(view);
  if (playable.length === 0) {
    /*
     * The pile. One move for three situations, exactly as it is for a human:
     * nothing matches, a +2 run has to be paid in full, or a Plus obligation is
     * being settled from the pile rather than from the hand.
     */
    return { type: 'drawCard' };
  }
  return playChoice(pickBest(playable, view, random), view);
}

/** The single playable card that would end the round, if the robot holds one. */
function winningCard(view: BotView): Card | null {
  if (view.hand.length !== 1) {
    return null;
  }
  const only = view.hand[0] as Card;
  const context = playContextFromPublic(view.table);
  // A breaker cannot win: its three cards are drawn before the win check.
  if (only.kind === 'breakPlusThree' || !isCardPlayable(only, context)) {
    return null;
  }
  return only;
}

/**
 * A seat sitting on a single card it never declared, if there is one to call out.
 *
 * Absence is the one exception, and it is not the robot's kindness: somebody who
 * is not there cannot shout, so calling them out would be farming rather than
 * catching. A seat a robot is playing counts as present — it can shout.
 */
function silentSeat(view: BotView): string | null {
  for (const player of view.table.players) {
    const present = view.seats.find((seat) => seat.id === player.id)?.present ?? false;
    if (
      player.id !== view.playerId &&
      player.left !== true &&
      present &&
      player.cardCount === 1 &&
      !view.table.declaredLastCard.includes(player.id)
    ) {
      return player.id;
    }
  }
  return null;
}

/**
 * The one entry point: what this robot owes the table right now, or `null`.
 *
 * The order is deliberate:
 *
 * 1. A +3 freezes the whole table, so answering it comes before everything. While
 *    it is open, the only other legal moves are the two shouts — declaring and
 *    calling somebody out — and they stay available.
 * 2. A card that ends the round is played immediately. The declaration is not what
 *    wins, so pausing to shout first would only give the table time to catch it.
 * 3. Declaring a last card is free and does not touch the turn, so it comes before
 *    playing: a robot that played first would spend the round being caught.
 * 4. Then the turn.
 * 5. Calling somebody else out comes last, and (in the driver) slowest, because it
 *    is the one move a human at the table would rather make themselves.
 */
export function chooseBotMove(view: BotView, random: () => number): BotMove | null {
  const { table, hand, playerId } = view;
  if (table.phase !== 'playing') {
    return null;
  }
  const me = table.players.find((player) => player.id === playerId);
  if (!me || me.left === true) {
    return null;
  }

  const frozen = table.plusThree !== null;
  if (frozen && view.canAnswerPlusThree) {
    /*
     * Only from a seat the engine is actually waiting on. Holding a breaker is not
     * the same question — a hand can gain one mid-window — and a breaker from a seat
     * nobody is waiting for is refused, as is `passBreak`. So there is nothing to
     * answer and nothing to decline; the two shouts below stay available.
     */
    const breaker = hand.find((card) => card.kind === 'breakPlusThree');
    if (breaker) {
      return { action: play(breaker), kind: 'breaker' };
    }
  }

  const myTurn = !frozen && table.currentPlayerId === playerId;
  const declared = table.declaredLastCard.includes(playerId);

  if (myTurn) {
    const winning = winningCard(view);
    if (winning) {
      return { action: playChoice(winning, view), kind: 'turn' };
    }
  }

  if (hand.length === 1 && !declared) {
    return { action: { type: 'declareLastCard' }, kind: 'declare' };
  }

  if (myTurn) {
    const action = turnAction(view, random);
    const inSequence = table.takiMode !== null && table.takiMode.playerId === playerId;
    return { action, kind: 'turn', ...(inSequence ? { inSequence } : {}) };
  }

  const target = silentSeat(view);
  if (target !== null) {
    return { action: { type: 'catchLastCard', targetId: target }, kind: 'catch' };
  }

  return null;
}
