import { describe, expect, it } from 'vitest';
import { BotRunner } from '../../../src/features/game/bot/runner.ts';
import { botViewFor } from '../../../src/features/game/bot/view.ts';
import type { BotMove } from '../../../src/features/game/bot/policy.ts';
import { createRng, nextFloat } from '../../../src/features/game/engine/prng.ts';
import type { GameState } from '../../../src/features/game/engine/state.ts';
import { cards, makeState, players } from '../helpers/engineFixtures.ts';

/**
 * The driver, with its timer in the test's hand.
 *
 * Everything here is about the two ways a robot can wreck a table: acting on a
 * decision the table has moved past, and asking for a move the table refuses, for
 * ever, at the cost of every other seat's turn.
 */

const ANN = 'p-ann';
const BEN = 'p-ben';

interface Harness {
  readonly runner: BotRunner;
  readonly submitted: { playerId: string; move: BotMove }[];
  /** Pauses armed, in order, live or cancelled. */
  readonly pauses: { ms: number; run: () => void; cancelled?: boolean }[];
  /** Runs the oldest pause that is still live. */
  fire(): void;
  /**
   * Runs the oldest pause even if it was cancelled.
   *
   * A platform cannot un-queue a callback it has already scheduled, so the driver
   * has to be safe against one arriving late. This is how that is exercised.
   */
  fireCancelled(): void;
  state: GameState;
  controlled: string[];
  blocked: boolean;
  accept: boolean;
}

function harness(
  initial: GameState,
  controlled: string[] = [ANN],
  random: () => number = () => 0.5,
): Harness {
  const pauses: { ms: number; run: () => void; cancelled?: boolean }[] = [];
  const submitted: { playerId: string; move: BotMove }[] = [];

  const box: Harness = {
    runner: undefined as unknown as BotRunner,
    submitted,
    pauses,
    fire() {
      const next = pauses.find((pause) => pause.cancelled !== true);
      if (!next) {
        throw new Error('no pause was armed');
      }
      next.cancelled = true;
      next.run();
    },
    fireCancelled() {
      const next = pauses[pauses.length - 1];
      if (!next) {
        throw new Error('nothing was ever armed');
      }
      next.run();
    },
    state: initial,
    controlled,
    blocked: false,
    accept: true,
  };

  const runner = new BotRunner({
    view: (playerId) => botViewFor(box.state, playerId, () => true),
    controlled: () => box.controlled.map((playerId) => ({ playerId, standIn: false })),
    blocked: () => box.blocked,
    submit: (playerId, move) => {
      submitted.push({ playerId, move });
      return box.accept;
    },
    random,
    schedule: (run, ms) => {
      const entry: { ms: number; run: () => void; cancelled?: boolean } = { ms, run };
      pauses.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    pauseMs: () => 10,
  });
  (box as { runner: BotRunner }).runner = runner;
  return box;
}

/** Ann on turn holding one playable card; Ben holds two. */
function turnForAnn(): GameState {
  return makeState({
    players: players('Ann', 'Ben'),
    hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4', 'blue:6') },
    currentPlayerIndex: 0,
    discardPile: cards('red:9'),
  });
}

describe('arming a pause', () => {
  it('waits before it moves, then plays', () => {
    const box = harness(turnForAnn());
    box.runner.schedule();
    expect(box.pauses).toHaveLength(1);
    expect(box.submitted).toHaveLength(0);

    box.fire();
    expect(box.submitted).toHaveLength(1);
    expect(box.submitted[0]?.playerId).toBe(ANN);
    expect(box.submitted[0]?.move.kind).toBe('turn');
  });

  it('does not restart the pause it is already in for the same move', () => {
    const box = harness(turnForAnn());
    box.runner.schedule();
    box.runner.schedule();
    box.runner.schedule();
    // A host re-broadcasts the lobby several times a minute; a robot that reset its
    // own pause each time would never reach the end of one.
    expect(box.pauses).toHaveLength(1);
  });

  it('keeps its decision while the table is unchanged, with a stream that really moves', () => {
    /*
     * The stub above cannot catch this: a real seat's randomness is a state that
     * advances on every draw, so a speculative re-decision both consumed the stream
     * and changed its own answer whenever two cards scored alike — cancelling the
     * pause it was in the middle of, on every heartbeat, indefinitely.
     */
    let stream = createRng(99);
    const box = harness(
      makeState({
        players: players('Ann', 'Ben'),
        // Four cards that all score alike, so a re-draw would pick a different one.
        hands: { [ANN]: cards('red:5', 'red:7', 'red:8', 'red:9'), [BEN]: cards('blue:4', 'blue:6') },
        currentPlayerIndex: 0,
        discardPile: cards('red:3'),
      }),
      [ANN],
      () => {
        const next = nextFloat(stream);
        stream = next.state;
        return next.value;
      },
    );

    box.runner.schedule();
    const first = box.pauses.length;
    for (let tick = 0; tick < 8; tick += 1) {
      box.runner.schedule();
    }
    expect(box.pauses).toHaveLength(first);

    box.fire();
    expect(box.submitted).toHaveLength(1);
  });

  it('arms nothing while the table is blocked, and cancels what was armed', () => {
    const box = harness(turnForAnn());
    box.runner.schedule();
    box.blocked = true;
    box.runner.schedule();
    // The pause is cancelled — and would be inert even if the platform ran it
    // anyway, which is the case a cancelled timer cannot rule out.
    box.fireCancelled();
    expect(box.submitted).toHaveLength(0);
  });

  it('does nothing after it is destroyed', () => {
    const box = harness(turnForAnn());
    box.runner.schedule();
    box.runner.destroy();
    box.fireCancelled();
    expect(box.submitted).toHaveLength(0);
    box.runner.schedule();
    // And it never arms another: a destroyed session's robots are done.
    expect(box.pauses).toHaveLength(1);
  });
});

describe('deciding again when the pause is over', () => {
  it('plays what the table looks like now, not what it looked like then', () => {
    const box = harness(turnForAnn());
    box.runner.schedule();

    // While it was "thinking", the turn moved on and its own hand came down to one
    // card — so the move it owes is no longer the one it was waiting to make.
    box.state = makeState({
      players: players('Ann', 'Ben'),
      hands: { [ANN]: cards('blue:5'), [BEN]: cards('blue:4', 'blue:6') },
      currentPlayerIndex: 1,
      discardPile: cards('red:9'),
      version: 9,
    });
    box.fire();

    expect(box.submitted).toHaveLength(1);
    expect(box.submitted[0]?.move.action).toEqual({ type: 'declareLastCard' });
  });

  it('gives up on a move the table refused, and lets another seat move instead', () => {
    /*
     * The case this exists for is a catch: whether a target may be called out
     * depends on presence and on a half-frame of grace, both of which are the
     * host's to know. A driver that kept asking would spend every heartbeat being
     * told no — and, with one pause at a time, would starve the seat that owes the
     * turn.
     */
    const state = makeState({
      players: players('Ann', 'Ben'),
      hands: { [ANN]: cards('blue:5', 'blue:7'), [BEN]: cards('red:4') },
      currentPlayerIndex: 1,
      discardPile: cards('red:9'),
    });
    const box = harness(state, [ANN, BEN]);
    box.accept = false;

    box.runner.schedule();
    box.fire();
    // Ben owed the turn, so that is what was tried first.
    expect(box.submitted).toHaveLength(1);
    expect(box.submitted[0]?.playerId).toBe(BEN);

    // Refused, so the next thing owed at this same table is tried — Ann's catch —
    // and after that there is nothing left to ask for.
    box.fire();
    expect(box.submitted.map((entry) => entry.playerId)).toEqual([BEN, ANN]);
    expect(() => {
      box.fire();
    }).toThrow('no pause was armed');
  });

  it('asks again once the state has moved on', () => {
    const box = harness(turnForAnn());
    box.accept = false;
    box.runner.schedule();
    box.fire();
    expect(box.submitted).toHaveLength(1);

    // A refusal is only remembered for the state it happened at: the same move at a
    // new version is a new question.
    box.state = { ...box.state, version: box.state.version + 1 };
    box.runner.schedule();
    box.fire();
    expect(box.submitted).toHaveLength(2);
  });
});

describe('choosing between seats', () => {
  it('answers a +3 before anything else at the table', () => {
    const state = makeState({
      players: players('Ann', 'Ben'),
      hands: { [ANN]: cards('breakPlusThree', 'red:5'), [BEN]: cards('blue:4', 'blue:6') },
      currentPlayerIndex: 1,
      plusThree: { playerId: BEN, awaiting: [ANN] },
      discardPile: cards('red:9'),
    });
    const box = harness(state, [ANN, BEN]);
    box.runner.schedule();
    box.fire();
    expect(box.submitted[0]?.move.kind).toBe('breaker');
  });

  it('lets a seat declare rather than making it wait for another seat’s turn', () => {
    const state = makeState({
      players: players('Ann', 'Ben'),
      hands: { [ANN]: cards('blue:5'), [BEN]: cards('red:4', 'red:6') },
      currentPlayerIndex: 1,
      discardPile: cards('red:9'),
    });
    const box = harness(state, [ANN, BEN]);
    box.runner.schedule();
    box.fire();
    /*
     * Ben owes the turn and Ann owes a declaration. A declaration costs the table
     * nothing and blocks nobody, and ranking it behind another seat's turn left a
     * robot sitting on an undeclared last card through every move in between.
     */
    expect(box.submitted[0]?.move.kind).toBe('declare');
    expect(box.submitted[0]?.playerId).toBe(ANN);
  });

  it('takes the turn before it shouts at anybody', () => {
    const state = makeState({
      players: players('Ann', 'Ben'),
      hands: { [ANN]: cards('red:5', 'red:7'), [BEN]: cards('blue:4') },
      currentPlayerIndex: 0,
      discardPile: cards('red:9'),
    });
    const box = harness(state, [ANN]);
    box.runner.schedule();
    box.fire();
    // Ann could call Ben out for a silent last card, and could play. The turn is
    // what keeps the table moving, so it comes first.
    expect(box.submitted[0]?.move.kind).toBe('turn');
  });
});
