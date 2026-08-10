import { describe, expect, it } from 'vitest';
import { applyCommand, createGame } from '../../../src/features/game/engine/engine.ts';
import {
  CARDS_DEALT_PER_PLAYER,
  STAIRS_STAGES,
  stairsHandSize,
} from '../../../src/features/game/engine/cards.ts';
import { toPublicGameState, computeStandings } from '../../../src/features/game/engine/views.ts';
import type { GameState } from '../../../src/features/game/engine/state.ts';
import { cards, eventTypes, expectOk, handOf, makeState, players } from '../helpers/engineFixtures.ts';

/**
 * "Stairs" — טאקי מדרגות.
 *
 * The mode changes exactly one thing: what an empty hand means. In a classic round
 * it is the end; here it is a step, and the player comes straight back with a hand
 * one card smaller — eight, seven, six … down to one — until the eighth empty hand
 * wins the round.
 *
 * That "exactly one thing" is what most of this file is about. A step happens in the
 * middle of a turn that is still being resolved, so the interesting cases are all
 * about what the *rest* of the turn does afterwards: a Plus still buys another card
 * to play, a Stop still skips the next seat, an open Taki sequence is still open, and
 * a declaration made about the card that has just gone down does not follow its owner
 * into the new hand.
 */

function totalCards(state: GameState): number {
  const inHands = Object.values(state.hands).reduce((sum, hand) => sum + hand.length, 0);
  return inHands + state.drawPile.length + state.discardPile.length;
}

/** A stairs round in which Alice is about to empty a hand of one. */
function aboutToStep(overrides: Parameters<typeof makeState>[0] = {}): GameState {
  return makeState({
    mode: 'stairs',
    hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
    discardPile: cards('red:9'),
    /*
     * Enough to cover the seven cards the next step deals, twice over — and all in
     * the colour the table is in, so whatever a step deals is playable. A hand that
     * happened to be unplayable would turn these into tests of the matching rules.
     */
    drawPile: cards(...Array.from({ length: 15 }, () => 'red:4')),
    ...overrides,
  });
}

function playFirst(state: GameState, playerId: string, declareLastCard = false) {
  const cardId = (state.hands[playerId] ?? [])[0]!.id;
  return applyCommand(state, {
    type: 'playCard',
    playerId,
    cardId,
    ...(declareLastCard ? { declareLastCard: true } : {}),
  });
}

describe('the staircase', () => {
  it('walks down one card at a time, from the deal to a single card', () => {
    expect(STAIRS_STAGES).toBe(CARDS_DEALT_PER_PLAYER);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(stairsHandSize)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('deals both modes the same opening hand, and records the mode on the round', () => {
    const seats = players('Alice', 'Bob');
    const stairs = expectOk(createGame(seats, 4242, 1, 0, 'stairs')).state;
    const classic = expectOk(createGame(seats, 4242, 1, 0)).state;

    expect(stairs.mode).toBe('stairs');
    expect(classic.mode).toBe('classic');
    expect(handOf(stairs, 'p-alice')).toHaveLength(CARDS_DEALT_PER_PLAYER);
    // Same seed, same deal: the modes diverge the first time somebody runs out.
    expect(handOf(stairs, 'p-alice')).toEqual(handOf(classic, 'p-alice'));
    expect(stairs.stairs).toEqual({ 'p-alice': 0, 'p-bob': 0 });
  });

  it('deals a new hand of seven instead of ending the round', () => {
    const state = aboutToStep();
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));

    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
    expect(next.stairs['p-alice']).toBe(1);
    expect(handOf(next, 'p-alice')).toHaveLength(7);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'stairsAdvanced', 'turnChanged']);
    expect(events.find((event) => event.type === 'stairsAdvanced')).toEqual({
      type: 'stairsAdvanced',
      playerId: 'p-alice',
      stage: 1,
      dealt: 7,
    });
  });

  it('takes the new hand off the draw pile and destroys nothing', () => {
    const state = aboutToStep();
    const { state: next } = expectOk(playFirst(state, 'p-alice'));

    expect(next.drawPile).toHaveLength(state.drawPile.length - 7);
    expect(totalCards(next)).toBe(totalCards(state));
  });

  it('says nothing about a staircase when the round is a classic one', () => {
    const state = aboutToStep({ mode: 'classic' });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));

    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(next.stairs['p-alice']).toBe(0);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'playerWon']);
  });

  it('wins the round on the eighth empty hand, and not on the seventh', () => {
    const seventh = expectOk(playFirst(aboutToStep({ stairs: { 'p-alice': 6 } }), 'p-alice')).state;
    expect(seventh.phase).toBe('playing');
    expect(seventh.stairs['p-alice']).toBe(7);
    // The seventh step is the hand of one: the last step of the staircase.
    expect(handOf(seventh, 'p-alice')).toHaveLength(1);

    // Her number card passed the turn on, as it does in either mode; the round
    // comes back to her holding the single card of the last step.
    const herTurnAgain: GameState = { ...seventh, currentPlayerIndex: 0 };
    const { state: won, events } = expectOk(playFirst(herTurnAgain, 'p-alice'));
    expect(won.phase).toBe('finished');
    expect(won.winnerId).toBe('p-alice');
    expect(won.endReason).toBe('won');
    expect(won.stairs['p-alice']).toBe(STAIRS_STAGES);
    expect(eventTypes(events)).toContain('playerWon');
    expect(eventTypes(events)).not.toContain('stairsAdvanced');
  });

  it('leaves the turn where the played card leaves it', () => {
    // A Plus emptied the hand: the extra turn it bought is played with the new one.
    const plus = expectOk(
      playFirst(aboutToStep({ hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1') } }), 'p-alice'),
    ).state;
    expect(plus.pendingPlus).toBe(true);
    expect(plus.currentPlayerIndex).toBe(0);
    expect(handOf(plus, 'p-alice')).toHaveLength(7);

    // A Stop still skips the seat it lands on, which at two players is the turn
    // coming straight back.
    const stop = expectOk(
      playFirst(aboutToStep({ hands: { 'p-alice': cards('red:stop'), 'p-bob': cards('red:1') } }), 'p-alice'),
    );
    expect(eventTypes(stop.events)).toEqual(['cardPlayed', 'stairsAdvanced', 'playerSkipped', 'turnChanged']);
    expect(stop.state.currentPlayerIndex).toBe(0);
  });

  it('keeps an open Taki sequence open across the step', () => {
    const state = aboutToStep({
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 1,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
      discardPile: cards('red:taki'),
      activeColor: 'red',
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));

    // Her sequence is still hers, and she carries on with a fresh hand of seven.
    expect(next.takiMode).toEqual({
      color: 'red',
      playerId: 'p-alice',
      cardsPlayed: 2,
      openedWithSuperTaki: false,
      takisOnly: false,
    });
    expect(next.currentPlayerIndex).toBe(0);
    expect(handOf(next, 'p-alice')).toHaveLength(7);
  });

  it('a Taki that opens a sequence still opens it from the new hand', () => {
    const state = aboutToStep({ hands: { 'p-alice': cards('red:taki'), 'p-bob': cards('red:1') } });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));

    expect(next.takiMode?.playerId).toBe('p-alice');
    expect(next.stairs['p-alice']).toBe(1);
  });

  /*
   * The declaration belongs to the card that was in the hand, not to the player.
   * The step down to the final hand of one is where this bites: without dropping the
   * declaration, a player who shouted for the card they have just played would arrive
   * at their last card already protected, and nobody could catch them for a shout
   * they never made.
   */
  it('does not carry a declaration into the hand a step deals', () => {
    const state = aboutToStep({
      stairs: { 'p-alice': 6 },
      declaredLastCard: ['p-alice'],
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));

    expect(handOf(next, 'p-alice')).toHaveLength(1);
    expect(next.declaredLastCard).toEqual([]);
  });

  it('does not let the shout made with a card cover the hand that replaces it', () => {
    const state = aboutToStep({ stairs: { 'p-alice': 6 } });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice', true));

    expect(handOf(next, 'p-alice')).toHaveLength(1);
    expect(next.declaredLastCard).toEqual([]);
    expect(eventTypes(events)).not.toContain('lastCardDeclared');

    // And the shout is still available, as its own move, for the card now in hand.
    const declared = expectOk(applyCommand(next, { type: 'declareLastCard', playerId: 'p-alice' })).state;
    expect(declared.declaredLastCard).toEqual(['p-alice']);
  });

  it('still declares with the play when the hand is merely down to one', () => {
    // Two cards in, one out: no step, so the ordinary rule applies untouched.
    const state = aboutToStep({
      mode: 'stairs',
      hands: { 'p-alice': cards('red:3', 'blue:4'), 'p-bob': cards('red:1') },
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice', true));

    expect(next.stairs['p-alice']).toBe(0);
    expect(next.declaredLastCard).toEqual(['p-alice']);
    expect(eventTypes(events)).toContain('lastCardDeclared');
  });

  it('reports a step short when the pile could not cover it', () => {
    const state = aboutToStep({
      // One card to draw, and a discard pile with nothing recyclable under its top.
      drawPile: cards('green:1'),
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));

    const step = events.find((event) => event.type === 'stairsAdvanced');
    expect(step).toMatchObject({ dealt: 2 });
    // Both cards it could find: the one in the pile, and the one recycled from
    // under the card she has just played.
    expect(handOf(next, 'p-alice')).toHaveLength(2);
    expect(eventTypes(events)).toContain('drawPileExhausted');
    expect(totalCards(next)).toBe(totalCards(state));
  });

  it('publishes every seat’s step, and only in a stairs round', () => {
    const stairs = toPublicGameState(makeState({ mode: 'stairs', stairs: { 'p-alice': 3 } }));
    expect(stairs.mode).toBe('stairs');
    expect(stairs.players.map((player) => player.stairsStep)).toEqual([3, 0]);

    const classic = toPublicGameState(makeState());
    expect(classic.mode).toBe('classic');
    expect(classic.players.every((player) => player.stairsStep === undefined)).toBe(true);
  });

  /*
   * Ranking by cards left is the right answer in a classic round and the wrong one
   * here: a player one step from the end may be holding two cards while somebody who
   * has emptied nothing holds one.
   */
  it('ranks the standings by the staircase first, and the hand second', () => {
    const state = makeState({
      mode: 'stairs',
      players: players('Alice', 'Bob', 'Cara'),
      hands: {
        'p-alice': cards('red:1', 'red:3'),
        'p-bob': cards('red:4'),
        'p-cara': cards('red:5', 'red:6'),
      },
      stairs: { 'p-alice': 6, 'p-bob': 0, 'p-cara': 6 },
    });
    const rows = computeStandings(toPublicGameState(state));

    expect(rows.map((row) => row.playerId)).toEqual(['p-alice', 'p-cara', 'p-bob']);
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(rows.map((row) => row.stairsStep)).toEqual([6, 6, 0]);
  });

  it('walks a whole staircase down to a win, dealing every step', () => {
    let state = aboutToStep({
      /*
       * Forty of the same card, so every step's hand is playable on the step
       * before it: this drill is about the sizes the staircase deals, and a hand
       * that happens to be unplayable would be testing the matching rules instead.
       */
      drawPile: cards(...Array.from({ length: 40 }, () => 'red:3')),
    });
    const dealt: number[] = [];
    for (let step = 1; step < STAIRS_STAGES; step += 1) {
      const result = expectOk(playFirst(state, 'p-alice'));
      const advance = result.events.find((event) => event.type === 'stairsAdvanced');
      expect(advance, `step ${String(step)} was not dealt`).toBeDefined();
      dealt.push(handOf(result.state, 'p-alice').length);
      // Straight back to her, holding a whole hand: the point of the drill is the
      // sizes, so the rest of the round is skipped rather than played.
      state = {
        ...result.state,
        currentPlayerIndex: 0,
        hands: { ...result.state.hands, 'p-alice': [result.state.hands['p-alice']![0]!] },
        drawPile: [...result.state.hands['p-alice']!.slice(1), ...result.state.drawPile],
      };
    }

    expect(dealt).toEqual([7, 6, 5, 4, 3, 2, 1]);
    const final = expectOk(playFirst(state, 'p-alice')).state;
    expect(final.winnerId).toBe('p-alice');
  });
});
