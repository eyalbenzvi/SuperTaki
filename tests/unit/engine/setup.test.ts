import { describe, expect, it } from 'vitest';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { CARDS_DEALT_PER_PLAYER, DECK_SIZE, isNumberCard } from '../../../src/features/game/engine/cards.ts';
import { players } from '../helpers/engineFixtures.ts';

function expectOk(result: ReturnType<typeof createGame>) {
  if (!result.ok) {
    throw new Error(`expected ok, got rejection ${result.rejection.code}`);
  }
  return result;
}

describe('createGame', () => {
  it('rejects fewer than two players', () => {
    const result = createGame(players('Solo'), 1);
    expect(result).toEqual({ ok: false, rejection: { code: 'notEnoughPlayers' } });
  });

  it('rejects more than six players', () => {
    const result = createGame(players('A', 'B', 'C', 'D', 'E', 'F', 'G'), 1);
    expect(result).toEqual({ ok: false, rejection: { code: 'tooManyPlayers' } });
  });

  it('rejects duplicate player ids', () => {
    const result = createGame(
      [
        { id: 'x', name: 'A' },
        { id: 'x', name: 'B' },
      ],
      1,
    );
    expect(result).toEqual({ ok: false, rejection: { code: 'duplicatePlayerId' } });
  });

  it.each([2, 3, 4, 5, 6])('deals %i players eight cards each and conserves the deck', (count) => {
    const seats = players(...Array.from({ length: count }, (_, index) => `P${index}`));
    const { state } = expectOk(createGame(seats, 2024));

    for (const seat of seats) {
      expect(state.hands[seat.id]).toHaveLength(CARDS_DEALT_PER_PLAYER);
    }
    const total =
      state.drawPile.length +
      state.discardPile.length +
      seats.reduce((sum, seat) => sum + (state.hands[seat.id]?.length ?? 0), 0);
    expect(total).toBe(DECK_SIZE);
  });

  it('starts with a number card face up and the matching active colour', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const { state } = expectOk(createGame(players('A', 'B', 'C'), seed));
      const top = state.discardPile.at(-1);
      expect(top).toBeDefined();
      expect(isNumberCard(top!)).toBe(true);
      expect(state.activeColor).toBe((top as { color: string }).color);
      expect(state.discardPile).toHaveLength(1);
    }
  });

  it('initialises turn state', () => {
    const { state, events } = expectOk(createGame(players('A', 'B'), 7));
    expect(state.version).toBe(1);
    expect(state.phase).toBe('playing');
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.direction).toBe(1);
    expect(state.takiMode).toBeNull();
    expect(state.pendingPlus).toBe(false);
    expect(state.winnerId).toBeNull();
    expect(state.seed).toBe(7);
    expect(events.map((event) => event.type)).toEqual(['gameStarted', 'turnChanged']);
  });

  it('is fully deterministic for a given seed', () => {
    const a = expectOk(createGame(players('A', 'B', 'C'), 555)).state;
    const b = expectOk(createGame(players('A', 'B', 'C'), 555)).state;
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));

    const c = expectOk(createGame(players('A', 'B', 'C'), 556)).state;
    expect(JSON.stringify(c)).not.toEqual(JSON.stringify(a));
  });

  it('deals round-robin so seat order matters', () => {
    const { state } = expectOk(createGame(players('A', 'B'), 31));
    const handA = state.hands['p-a'] ?? [];
    const handB = state.hands['p-b'] ?? [];
    expect(new Set([...handA, ...handB].map((card) => card.id)).size).toBe(16);
  });

  it('can continue an existing version sequence', () => {
    const { state } = expectOk(createGame(players('A', 'B'), 7, 42));
    expect(state.version).toBe(42);
  });

  it('survives a JSON round trip', () => {
    const { state } = expectOk(createGame(players('A', 'B'), 3));
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
