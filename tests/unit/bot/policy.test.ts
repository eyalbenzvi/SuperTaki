import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseBotMove } from '../../../src/features/game/bot/policy.ts';
import { botViewFor, type BotView } from '../../../src/features/game/bot/view.ts';
import { applyCommand, createGame } from '../../../src/features/game/engine/engine.ts';
import { createRng, nextFloat } from '../../../src/features/game/engine/prng.ts';
import type { Card } from '../../../src/features/game/engine/cards.ts';
import type { GameCommand, GameState, PlayerId } from '../../../src/features/game/engine/state.ts';
import { cards, makeState, players, type StateOverrides } from '../helpers/engineFixtures.ts';

/**
 * The robot's decisions, tested exactly as the engine's rules are: pure inputs,
 * exact outputs, no timers anywhere.
 *
 * Two of these are properties rather than examples, and they are the two that
 * matter most — a robot must never propose a move the engine refuses, and it must
 * not be able to see anybody else's cards.
 */

/** A stream of numbers a decision can be given without asking the clock. */
function seededRandom(seed = 7): () => number {
  let state = createRng(seed);
  return () => {
    const next = nextFloat(state);
    state = next.state;
    return next.value;
  };
}

/** Everything present, which is the ordinary case at a table. */
function viewOf(state: GameState, playerId: PlayerId): BotView {
  return botViewFor(state, playerId, () => true);
}

function decide(state: GameState, playerId: PlayerId, seed = 7): ReturnType<typeof chooseBotMove> {
  return chooseBotMove(viewOf(state, playerId), seededRandom(seed));
}

/** A three-handed table with hands the test dictates. */
function table(overrides: StateOverrides): GameState {
  return makeState({ players: players('Ann', 'Ben', 'Cat'), ...overrides });
}

const ANN = 'p-ann';
const BEN = 'p-ben';
const CAT = 'p-cat';

function idOfKind(hand: readonly Card[], kind: Card['kind']): string {
  const card = hand.find((candidate) => candidate.kind === kind);
  if (!card) {
    throw new Error(`no ${kind} in hand`);
  }
  return card.id;
}

describe('answering an open +3', () => {
  it('plays the breaker, which is the only card the table will take', () => {
    const hands = {
      [ANN]: cards('red:5'),
      [BEN]: cards('breakPlusThree', 'blue:4'),
      [CAT]: cards('red:3'),
    };
    const state = table({
      hands,
      plusThree: { playerId: ANN, awaiting: [BEN] },
      currentPlayerIndex: 0,
    });

    const move = decide(state, BEN);
    expect(move).toEqual({
      kind: 'breaker',
      action: { type: 'playCard', cardId: idOfKind(hands[BEN], 'breakPlusThree') },
    });
  });

  it('does nothing when it holds no breaker, rather than declining a window nobody is holding for it', () => {
    const state = table({
      hands: { [ANN]: cards('red:5', 'red:6'), [BEN]: cards('blue:4', 'blue:5'), [CAT]: cards('red:3') },
      plusThree: { playerId: ANN, awaiting: [CAT] },
      currentPlayerIndex: 0,
    });
    // `passBreak` from a seat that is not in `awaiting` is rejected, so proposing
    // one would be a rejection every heartbeat for as long as the window is open.
    // Cat is on one card, so this also pins that Ben's *only* reason to act would
    // have been the breaker it does not hold — the catch is Cat's business below.
    expect(decide(state, BEN)?.action).toEqual({ type: 'catchLastCard', targetId: CAT });
  });

  it('waits, rather than playing on, when the +3 it played is still open', () => {
    /*
     * The seat on turn is still the +3 player's while the window is open, so a
     * policy that only checked "is it my turn" would try to play a card and be
     * refused with `awaitingBreak` on every tick.
     */
    const state = table({
      // Two cards each elsewhere: nobody is on a last card, so there is genuinely
      // nothing else for Ann to owe while the window is open.
      hands: {
        [ANN]: cards('red:5', 'red:3'),
        [BEN]: cards('breakPlusThree', 'blue:8'),
        [CAT]: cards('red:3', 'red:4'),
      },
      plusThree: { playerId: ANN, awaiting: [BEN] },
      currentPlayerIndex: 0,
    });
    expect(decide(state, ANN)).toBeNull();
  });

  it('still declares its own last card while the table is frozen', () => {
    const state = table({
      hands: { [ANN]: cards('red:5'), [BEN]: cards('blue:4'), [CAT]: cards('red:3') },
      plusThree: { playerId: ANN, awaiting: [CAT] },
      currentPlayerIndex: 0,
    });
    expect(decide(state, BEN)?.action).toEqual({ type: 'declareLastCard' });
  });
});

describe('a +2 run', () => {
  it('raises it with a +2 rather than cancelling with a King', () => {
    const hands = {
      [ANN]: cards('red:5'),
      [BEN]: cards('blue:plusTwo', 'king', 'green:4'),
      [CAT]: cards('red:3'),
    };
    const state = table({ hands, currentPlayerIndex: 1, pendingDraw: 2, discardPile: cards('red:plusTwo') });
    expect(decide(state, BEN)?.action).toEqual({
      type: 'playCard',
      cardId: idOfKind(hands[BEN], 'plusTwo'),
    });
  });

  it('cancels with a King when that is all it has', () => {
    const hands = { [ANN]: cards('red:5'), [BEN]: cards('king', 'green:4'), [CAT]: cards('red:3') };
    const state = table({ hands, currentPlayerIndex: 1, pendingDraw: 4, discardPile: cards('red:plusTwo') });
    expect(decide(state, BEN)?.action).toEqual({ type: 'playCard', cardId: idOfKind(hands[BEN], 'king') });
  });

  it('pays the run when it can answer neither way', () => {
    const state = table({
      hands: { [ANN]: cards('red:5'), [BEN]: cards('green:4', 'blue:7'), [CAT]: cards('red:3') },
      currentPlayerIndex: 1,
      pendingDraw: 6,
      discardPile: cards('red:plusTwo'),
    });
    expect(decide(state, BEN)?.action).toEqual({ type: 'drawCard' });
  });
});

describe('inside its own Taki sequence', () => {
  const sequence = (hand: Card[]): GameState =>
    table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:taki'),
      activeColor: 'red',
      takiMode: { color: 'red', playerId: ANN, cardsPlayed: 1, openedWithSuperTaki: false },
    });

  it('spends the numbers first and keeps the punishing card for the close', () => {
    const hand = cards('red:plusTwo', 'red:5', 'red:stop');
    const state = sequence(hand);
    const first = decide(state, ANN);
    expect(first?.action).toEqual({ type: 'playCard', cardId: idOfKind(hand, 'number') });
    // And it is marked as a sequence move, which is what makes the driver brisk.
    expect(first?.inSequence).toBe(true);
  });

  it('closes when nothing of the sequence colour is left', () => {
    const state = sequence(cards('blue:5', 'green:stop'));
    expect(decide(state, ANN)?.action).toEqual({ type: 'closeTaki' });
  });

  it('closes rather than trying to re-colour the sequence', () => {
    /*
     * A sequence keeps the colour it opened in, so a Taki of another colour is not a
     * pivot — it is simply illegal inside it. A robot that offered one would be
     * refused, which is the whole reason it chooses through the shared rule.
     */
    const state = sequence(cards('blue:taki', 'blue:5', 'blue:7'));
    expect(decide(state, ANN)?.action).toEqual({ type: 'closeTaki' });
  });

  it('spends another Taki of the sequence colour like any other card of it', () => {
    const hand = cards('red:taki', 'red:stop');
    const state = sequence(hand);
    // Numbers and Takis go down first; the Stop is kept to close on.
    expect(decide(state, ANN)?.action).toEqual({ type: 'playCard', cardId: idOfKind(hand, 'taki') });
  });

  it('plays the last card of the hand and wins', () => {
    const hand = cards('red:5');
    const state = sequence(hand);
    expect(decide(state, ANN)?.action).toEqual({ type: 'playCard', cardId: hand[0]?.id });
  });
});

describe('an ordinary turn', () => {
  it('prefers a +3 to anything else it holds', () => {
    const hand = cards('plusThree', 'red:5', 'red:stop');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    expect(decide(state, ANN)?.action).toEqual({
      type: 'playCard',
      cardId: idOfKind(hand, 'plusThree'),
    });
  });

  it('hoards the King while something ordinary is legal', () => {
    const hand = cards('king', 'red:5');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    expect(decide(state, ANN)?.action).toEqual({ type: 'playCard', cardId: idOfKind(hand, 'number') });
  });

  it('names the colour it is strongest in when it plays a Change Colour', () => {
    const hand = cards('colorChange', 'green:4', 'green:7', 'blue:5');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    // Nothing else is legal on a red 9 with no red card, so the wild goes down and
    // the table is repainted green — the colour with two cards behind it.
    expect(decide(state, ANN)?.action).toEqual({
      type: 'playCard',
      cardId: idOfKind(hand, 'colorChange'),
      chosenColor: 'green',
    });
  });

  it('names a colour even when nothing coloured is left to count', () => {
    // One colourless card, which is also the winning one: the choice has nothing to
    // count and still has to be made.
    const hand = cards('colorChange');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4', 'blue:6'), [CAT]: cards('green:4', 'green:6') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    const move = decide(state, ANN);
    // A missing colour is rejected outright by the engine, so the choice has to be
    // total: with nothing to count it keeps the colour already leading.
    expect(move?.action).toMatchObject({ type: 'playCard', chosenColor: 'red' });
    expect(applyCommand(state, { ...(move?.action as GameCommand), playerId: ANN }).ok).toBe(true);
  });

  it('asks for no colour with a Super Taki, which the engine would refuse', () => {
    const hand = cards('superTaki', 'blue:5');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    const move = decide(state, ANN);
    expect(move?.action).toEqual({ type: 'playCard', cardId: idOfKind(hand, 'superTaki') });
  });

  it('draws rather than spending a breaker with no +3 to break', () => {
    /*
     * A breaker is a legal card here, and an expensive one: three cards, drawn
     * before the win check. One card from the pile is strictly cheaper, so the
     * robot never spends it speculatively.
     */
    const state = table({
      hands: { [ANN]: cards('breakPlusThree', 'blue:5'), [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    expect(decide(state, ANN)?.action).toEqual({ type: 'drawCard' });
  });

  it('draws when nothing matches at all', () => {
    const state = table({
      hands: { [ANN]: cards('blue:5', 'green:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    expect(decide(state, ANN)?.action).toEqual({ type: 'drawCard' });
  });
});

describe('the last card', () => {
  it('plays the winning card instead of pausing to declare', () => {
    const hand = cards('red:5');
    const state = table({
      hands: { [ANN]: hand, [BEN]: cards('blue:4', 'blue:5'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    // The declaration is not what wins, so shouting first would only hand the table
    // a window in which to catch it.
    expect(decide(state, ANN)?.action).toEqual({ type: 'playCard', cardId: hand[0]?.id });
  });

  it('declares when it cannot play the card', () => {
    const state = table({
      hands: { [ANN]: cards('blue:5'), [BEN]: cards('blue:4', 'blue:7'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    expect(decide(state, ANN)?.action).toEqual({ type: 'declareLastCard' });
  });

  it('declares out of turn, and only once', () => {
    const base: StateOverrides = {
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    };
    expect(decide(table(base), BEN)?.action).toEqual({ type: 'declareLastCard' });
    expect(decide(table({ ...base, declaredLastCard: [BEN] }), BEN)?.action).not.toEqual({
      type: 'declareLastCard',
    });
  });
});

describe('calling somebody out', () => {
  it('catches a present seat sitting on one silent card', () => {
    const state = table({
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4', 'green:5') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    // Ann is on turn but a win is not available, so the shout is what it owes.
    expect(decide(state, CAT)?.action).toEqual({ type: 'catchLastCard', targetId: BEN });
  });

  it('leaves a seat that has declared alone', () => {
    const state = table({
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4', 'green:5') },
      currentPlayerIndex: 0,
      declaredLastCard: [BEN],
      discardPile: cards('red:9'),
    });
    expect(decide(state, CAT)).toBeNull();
  });

  it('never calls out somebody who is not there', () => {
    const state = table({
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4', 'green:5') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    // Somebody who is not there cannot shout, so calling them out is farming rather
    // than catching — and the host refuses it anyway.
    const view = botViewFor(state, CAT, (playerId) => playerId !== BEN);
    expect(chooseBotMove(view, seededRandom())).toBeNull();
  });

  it('never calls out a seat that has left the round', () => {
    const state = makeState({
      players: [
        { id: ANN, name: 'Ann' },
        { id: BEN, name: 'Ben', left: true },
        { id: CAT, name: 'Cat' },
      ],
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4'), [CAT]: cards('green:4', 'green:5') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    expect(decide(state, CAT)).toBeNull();
  });
});

describe('a round played entirely by robots', () => {
  /**
   * Plays a whole round through the engine, every seat decided by the policy.
   *
   * This is the "never illegal" property: several hundred real decisions, each
   * checked against the authoritative engine. A policy that proposed one refused
   * move would fail here rather than in production, where the same move would be a
   * table waiting for a robot that keeps being told no.
   */
  function playRound(seed: number): { state: GameState; moves: number } {
    const dealt = createGame(players('Ann', 'Ben', 'Cat'), seed);
    if (!dealt.ok) {
      throw new Error('the deal itself was rejected');
    }
    let state = dealt.state;
    const random = seededRandom(seed);
    let moves = 0;

    while (state.phase === 'playing' && moves < 4_000) {
      let acted = false;
      for (const player of state.players) {
        const move = chooseBotMove(viewOf(state, player.id), random);
        if (!move) {
          continue;
        }
        const command = { ...move.action, playerId: player.id } as GameCommand;
        const result = applyCommand(state, command);
        expect(
          result.ok,
          `${player.id} proposed ${JSON.stringify(move.action)} and the engine said ${
            result.ok ? '' : result.rejection.code
          }`,
        ).toBe(true);
        if (!result.ok) {
          return { state, moves };
        }
        state = result.state;
        moves += 1;
        acted = true;
        break;
      }
      expect(acted, 'no seat owed anything, so the table would have stopped').toBe(true);
      if (!acted) {
        return { state, moves };
      }
    }
    return { state, moves };
  }

  it.each([1, 2, 3, 4242, 999_331])('finishes cleanly from seed %i', (seed) => {
    const { state, moves } = playRound(seed);
    expect(state.phase).toBe('finished');
    expect(state.winnerId).not.toBeNull();
    expect(moves).toBeGreaterThan(10);
  });

  it('conserves every card in the deck along the way', () => {
    const { state } = playRound(4242);
    const ids = [
      ...Object.values(state.hands).flatMap((hand) => hand.map((card) => card.id)),
      ...state.drawPile.map((card) => card.id),
      ...state.discardPile.map((card) => card.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(116);
  });
});

describe('what a robot cannot see', () => {
  it('does not put anybody else’s card in the view at all', () => {
    const dealt = createGame(players('Ann', 'Ben', 'Cat'), 4242);
    if (!dealt.ok) {
      throw new Error('the deal itself was rejected');
    }
    const state = dealt.state;
    const serialised = JSON.stringify(viewOf(state, ANN));
    const foreign = [...(state.hands[BEN] ?? []), ...(state.hands[CAT] ?? []), ...state.drawPile].map(
      (card) => card.id,
    );

    for (const id of foreign) {
      expect(serialised, `leaked ${id}`).not.toContain(id);
    }
  });

  it('decides the same way however the other hands are rearranged', () => {
    /*
     * The real assertion is at the seam, not in the types: the view is built from a
     * `GameState` that contains every hand, so this scrambles the *other* players'
     * cards — keeping each hand's size, and keeping the deck honest — and requires
     * both the same decision and a decision the engine still accepts.
     */
    const dealt = createGame(players('Ann', 'Ben', 'Cat'), 20_260_805);
    if (!dealt.ok) {
      throw new Error('the deal itself was rejected');
    }
    const state = dealt.state;
    const baseline = decide(state, ANN);

    const others = [...(state.hands[BEN] ?? []), ...(state.hands[CAT] ?? []), ...state.drawPile];
    for (let rotation = 1; rotation < 8; rotation += 1) {
      const shifted = [...others.slice(rotation), ...others.slice(0, rotation)];
      const benSize = (state.hands[BEN] ?? []).length;
      const catSize = (state.hands[CAT] ?? []).length;
      const scrambled: GameState = {
        ...state,
        hands: {
          ...state.hands,
          [BEN]: shifted.slice(0, benSize),
          [CAT]: shifted.slice(benSize, benSize + catSize),
        },
        drawPile: shifted.slice(benSize + catSize),
      };

      const move = decide(scrambled, ANN);
      expect(move).toEqual(baseline);
      const command = { ...(move?.action as GameCommand), playerId: ANN };
      expect(applyCommand(scrambled, command).ok).toBe(true);
    }
  });
});

describe('when there is nothing to decide', () => {
  it('says nothing once the round is over', () => {
    const state = table({
      hands: { [ANN]: cards('red:5'), [BEN]: cards('blue:4'), [CAT]: cards('green:4') },
      phase: 'finished',
      winnerId: BEN,
      currentPlayerIndex: 0,
    });
    expect(decide(state, ANN)).toBeNull();
  });

  it('says nothing for a seat that has left the round', () => {
    const state = makeState({
      players: [
        { id: ANN, name: 'Ann', left: true },
        { id: BEN, name: 'Ben' },
        { id: CAT, name: 'Cat' },
      ],
      hands: { [ANN]: cards('red:5'), [BEN]: cards('blue:4', 'blue:6'), [CAT]: cards('green:4', 'green:6') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    // Their cards are frozen out of play, so every command from them is refused —
    // including the declaration their single card would otherwise owe.
    expect(decide(state, ANN)).toBeNull();
  });

  it('scores a table with nobody left to punish without falling over', () => {
    const hand = cards('red:plusTwo', 'red:5');
    const state = makeState({
      players: [
        { id: ANN, name: 'Ann' },
        { id: BEN, name: 'Ben', left: true },
      ],
      hands: { [ANN]: hand, [BEN]: cards('blue:4', 'blue:6') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    // There is no next seat to weigh, so the +2 is scored on its own merits rather
    // than on a card count that does not exist.
    expect(decide(state, ANN)?.action).toEqual({
      type: 'playCard',
      cardId: idOfKind(hand, 'plusTwo'),
    });
  });
});

describe('the shape of the package', () => {
  it('lets only the view see the authoritative state', () => {
    /*
     * The fairness argument is that a robot is handed a projection, not the game.
     * That holds only while `view.ts` is the single door to a `GameState` — so this
     * checks the door rather than trusting the convention, which is the sort of thing
     * a refactor breaks silently and a reviewer reads straight past.
     */
    const directory = join(process.cwd(), 'src/features/game/bot');
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(files).toContain('view.ts');

    for (const name of files) {
      if (name === 'view.ts') {
        continue;
      }
      const source = readFileSync(join(directory, name), 'utf8');
      // `PlayerId` and the other aliases are fine — they are strings. `GameState` is
      // the one type that carries every hand, so it is the one the door is for.
      expect(source, `${name} reaches for the authoritative state`).not.toMatch(/\bGameState\b/);
    }
  });
});
