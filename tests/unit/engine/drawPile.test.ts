import { describe, expect, it } from 'vitest';
import { applyCommand, currentPlayer, topCard } from '../../../src/features/game/engine/engine.ts';
import { cards, eventTypes, expectOk, makeState } from '../helpers/engineFixtures.ts';

describe('draw pile recycling', () => {
  it('recycles the discard pile, keeping the visible top card', () => {
    const discard = cards('red:9', 'red:3', 'blue:3', 'green:3', 'yellow:3');
    const state = makeState({
      hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
      drawPile: [],
      discardPile: discard,
      activeColor: 'yellow',
    });

    const { state: next, events } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));

    expect(eventTypes(events)).toEqual(['drawPileRecycled', 'cardDrawn', 'turnChanged']);
    expect(topCard(next)?.id).toBe(discard.at(-1)!.id);
    expect(next.discardPile).toHaveLength(1);
    // Four cards were recycled, one of which was immediately drawn.
    expect(next.drawPile).toHaveLength(3);
    expect(next.hands['p-alice']).toHaveLength(2);
  });

  it('conserves every card while recycling', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
      drawPile: [],
      discardPile: cards('red:9', 'red:3', 'blue:3'),
    });
    const before = new Set(
      [
        ...state.drawPile,
        ...state.discardPile,
        ...(state.hands['p-alice'] ?? []),
        ...(state.hands['p-bob'] ?? []),
      ].map((card) => card.id),
    );
    const next = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' })).state;
    const after = new Set(
      [
        ...next.drawPile,
        ...next.discardPile,
        ...(next.hands['p-alice'] ?? []),
        ...(next.hands['p-bob'] ?? []),
      ].map((card) => card.id),
    );
    expect(after).toEqual(before);
  });

  it('recycles deterministically for a given rng state', () => {
    const build = () =>
      makeState({
        hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
        drawPile: [],
        discardPile: cards('red:9', 'red:3', 'blue:3', 'green:4', 'yellow:5'),
      });
    const a = expectOk(applyCommand(build(), { type: 'drawCard', playerId: 'p-alice' })).state;
    const b = expectOk(applyCommand(build(), { type: 'drawCard', playerId: 'p-alice' })).state;
    expect(a.drawPile.map((card) => card.id.split('#')[0])).toEqual(
      b.drawPile.map((card) => card.id.split('#')[0]),
    );
  });

  it('advances the rng state when recycling', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
      drawPile: [],
      discardPile: cards('red:9', 'red:3', 'blue:3'),
    });
    const next = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' })).state;
    expect(next.rng.seed).not.toBe(state.rng.seed);
  });
});

describe('exhausted draw pile', () => {
  it('reports exhaustion and still ends the turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
      drawPile: [],
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));
    expect(eventTypes(events)).toEqual(['drawPileExhausted', 'turnChanged']);
    expect(next.hands['p-alice']).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('lets a plus obligation lapse when there is nothing to draw', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('blue:8'), 'p-bob': cards('red:1') },
      drawPile: [],
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));
    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });
});
