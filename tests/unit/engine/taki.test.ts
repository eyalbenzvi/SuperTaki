import { describe, expect, it } from 'vitest';
import { applyCommand, currentPlayer, topCard } from '../../../src/features/game/engine/engine.ts';
import { getPlayableCardIds } from '../../../src/features/game/engine/rules.ts';
import {
  cards,
  eventTypes,
  expectOk,
  expectRejected,
  makeState,
  players,
} from '../helpers/engineFixtures.ts';
import type { CardColor } from '../../../src/features/game/engine/cards.ts';
import type { GameState } from '../../../src/features/game/engine/state.ts';

function play(state: GameState, playerId: string, spec: string, chosenColor?: CardColor) {
  const match = (state.hands[playerId] ?? []).find((candidate) => candidate.id.startsWith(`${spec}#`));
  if (!match) {
    throw new Error(`${spec} not in hand`);
  }
  return applyCommand(
    state,
    chosenColor
      ? { type: 'playCard', playerId, cardId: match.id, chosenColor }
      : { type: 'playCard', playerId, cardId: match.id },
  );
}

describe('opening a taki sequence', () => {
  it('opens taki mode in the card colour and keeps the turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:taki', 'red:3', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice', 'red:taki'));

    expect(next.takiMode).toEqual({
      color: 'red',
      playerId: 'p-alice',
      cardsPlayed: 1,
      openedWithSuperTaki: false,
    });
    expect(currentPlayer(next)?.id).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'takiOpened']);
  });

  it('only offers cards of the sequence colour afterwards', () => {
    const state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'red:3', 'red:stop', 'blue:3', 'colorChange'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    const next = expectOk(play(state, 'p-alice', 'red:taki')).state;
    const playable = getPlayableCardIds(next.hands['p-alice'] ?? [], {
      activeColor: next.activeColor,
      topCard: topCard(next),
      openTakiColor: next.takiMode?.color ?? null,
      pendingDraw: next.pendingDraw,
      freePlay: next.freePlay,
    });
    expect(playable).toHaveLength(2);
  });
});

describe('playing inside a taki sequence', () => {
  const base = () =>
    makeState({
      hands: {
        'p-alice': cards('red:taki', 'red:3', 'red:4', 'red:stop', 'blue:3', 'colorChange'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });

  it('accepts consecutive same-colour cards without changing the turn', () => {
    let state = expectOk(play(base(), 'p-alice', 'red:taki')).state;
    state = expectOk(play(state, 'p-alice', 'red:3')).state;
    state = expectOk(play(state, 'p-alice', 'red:4')).state;

    expect(state.takiMode?.cardsPlayed).toBe(3);
    expect(currentPlayer(state)?.id).toBe('p-alice');
    expect(state.hands['p-alice']).toHaveLength(3);
  });

  it('rejects a different colour', () => {
    const state = expectOk(play(base(), 'p-alice', 'red:taki')).state;
    expectRejected(play(state, 'p-alice', 'blue:3'), 'wrongTakiColor');
  });

  it('rejects wild cards', () => {
    const state = expectOk(play(base(), 'p-alice', 'red:taki')).state;
    expectRejected(play(state, 'p-alice', 'colorChange', 'red'), 'wildNotAllowedInTaki');
  });

  it('rejects drawing', () => {
    const state = expectOk(play(base(), 'p-alice', 'red:taki')).state;
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }), 'cannotDrawDuringTaki');
  });

  it('does not apply special effects until the sequence closes', () => {
    let state = expectOk(play(base(), 'p-alice', 'red:taki')).state;
    state = expectOk(play(state, 'p-alice', 'red:stop')).state;
    expect(currentPlayer(state)?.id).toBe('p-alice');
    expect(state.pendingPlus).toBe(false);
    expect(state.takiMode?.cardsPlayed).toBe(2);
  });

  it('continues the sequence when another taki of the same colour is played', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:taki', 'red:taki', 'red:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    let next = expectOk(play(state, 'p-alice', 'red:taki')).state;
    const result = expectOk(play(next, 'p-alice', 'red:taki'));
    next = result.state;
    expect(next.takiMode?.cardsPlayed).toBe(2);
    expect(next.takiMode?.color).toBe('red');
    expect(eventTypes(result.events)).toEqual(['cardPlayed']);
    expect(currentPlayer(next)?.id).toBe('p-alice');
  });

  it('refuses a taki of another colour and keeps the sequence colour', () => {
    const state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'blue:taki', 'blue:3', 'red:3'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    const next = expectOk(play(state, 'p-alice', 'red:taki')).state;
    // A sequence is defined by its colour, and nothing inside it repaints the
    // table — Taki cards included.
    expectRejected(play(next, 'p-alice', 'blue:taki'), 'wrongTakiColor');
    expectRejected(play(next, 'p-alice', 'blue:3'), 'wrongTakiColor');

    expect(next.takiMode?.color).toBe('red');
    expect(next.activeColor).toBe('red');
    // Only the red card is on offer, and playing it leaves the sequence red.
    expect(
      getPlayableCardIds(next.hands['p-alice'] ?? [], {
        activeColor: next.activeColor,
        topCard: topCard(next),
        openTakiColor: next.takiMode?.color ?? null,
        pendingDraw: next.pendingDraw,
        freePlay: next.freePlay,
      }),
    ).toEqual([(next.hands['p-alice'] ?? []).find((card) => card.id.startsWith('red:3#'))?.id]);
    const after = expectOk(play(next, 'p-alice', 'red:3')).state;
    expect(after.takiMode?.color).toBe('red');
    expect(after.takiMode?.cardsPlayed).toBe(2);
  });

  it('cannot open a second sequence in another colour in the same turn', () => {
    // The reported bug, verbatim: a green Taki, green cards after it, and then a
    // red Taki in the same turn, which used to carry the sequence into red.
    let state = makeState({
      hands: {
        'p-alice': cards('green:taki', 'green:3', 'green:7', 'red:taki', 'red:4'),
        'p-bob': cards('yellow:1'),
      },
      discardPile: cards('green:9'),
    });
    state = expectOk(play(state, 'p-alice', 'green:taki')).state;
    state = expectOk(play(state, 'p-alice', 'green:3')).state;
    state = expectOk(play(state, 'p-alice', 'green:7')).state;

    expectRejected(play(state, 'p-alice', 'red:taki'), 'wrongTakiColor');
    expectRejected(play(state, 'p-alice', 'red:4'), 'wrongTakiColor');
    expect(state.takiMode?.color).toBe('green');
    expect(state.activeColor).toBe('green');

    // Closing hands the turn on: the red cards wait for a turn of their own.
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
  });

  it('opens a sequence of your own when a taki lands on a taki with none open', () => {
    // The move the removed rule was confused with: a Taki on a Taki lying on the
    // pile is an ordinary symbol match, and it starts your sequence, not a
    // continuation of anyone else's.
    const state = makeState({
      currentPlayerIndex: 1,
      hands: { 'p-alice': cards('green:3'), 'p-bob': cards('red:taki', 'red:5') },
      discardPile: cards('green:taki'),
      activeColor: 'green',
    });
    const { state: next, events } = expectOk(play(state, 'p-bob', 'red:taki'));
    expect(next.takiMode).toEqual({
      color: 'red',
      playerId: 'p-bob',
      cardsPlayed: 1,
      openedWithSuperTaki: false,
    });
    expect(eventTypes(events)).toEqual(['cardPlayed', 'takiOpened']);
  });
});

describe('closing a taki sequence', () => {
  it('rejects closing when no sequence is open', () => {
    expectRejected(applyCommand(makeState(), { type: 'closeTaki', playerId: 'p-alice' }), 'noTakiOpen');
  });

  it('rejects closing a sequence owned by someone else', () => {
    const state = makeState({
      currentPlayerIndex: 1,
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 1, openedWithSuperTaki: false },
    });
    expectRejected(applyCommand(state, { type: 'closeTaki', playerId: 'p-bob' }), 'noTakiOpen');
  });

  it('passes the turn when the last card is a number', () => {
    let state = expectOk(
      play(
        makeState({
          hands: { 'p-alice': cards('red:taki', 'red:3', 'blue:3'), 'p-bob': cards('red:1') },
          discardPile: cards('red:9'),
        }),
        'p-alice',
        'red:taki',
      ),
    ).state;
    state = expectOk(play(state, 'p-alice', 'red:3')).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
    expect(closed.state.takiMode).toBeNull();
    expect(eventTypes(closed.events)).toEqual(['takiClosed', 'turnChanged']);
  });

  it('passes the turn when the sequence contains only the taki card', () => {
    const state = expectOk(
      play(
        makeState({
          hands: { 'p-alice': cards('red:taki', 'blue:3'), 'p-bob': cards('red:1') },
          discardPile: cards('red:9'),
        }),
        'p-alice',
        'red:taki',
      ),
    ).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
  });

  it('applies a trailing stop card', () => {
    const table = players('Alice', 'Bob', 'Carol');
    let state = expectOk(
      play(
        makeState({
          players: table,
          hands: {
            'p-alice': cards('red:taki', 'red:stop', 'blue:3'),
            'p-bob': cards('red:1'),
            'p-carol': cards('red:3'),
          },
          discardPile: cards('red:9'),
        }),
        'p-alice',
        'red:taki',
      ),
    ).state;
    state = expectOk(play(state, 'p-alice', 'red:stop')).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(currentPlayer(closed.state)?.id).toBe('p-carol');
  });

  it('applies a trailing plus card and keeps the turn', () => {
    let state = expectOk(
      play(
        makeState({
          hands: { 'p-alice': cards('red:taki', 'red:plus', 'blue:plus'), 'p-bob': cards('red:1') },
          discardPile: cards('red:9'),
        }),
        'p-alice',
        'red:taki',
      ),
    ).state;
    state = expectOk(play(state, 'p-alice', 'red:plus')).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(closed.state.pendingPlus).toBe(true);
    expect(currentPlayer(closed.state)?.id).toBe('p-alice');
    expect(closed.state.takiMode).toBeNull();
    // The outstanding card follows normal matching, not the taki colour:
    // a blue Plus is legal on a red Plus because the symbols match.
    expectOk(play(closed.state, 'p-alice', 'blue:plus'));
  });

  it('applies a trailing change-direction card', () => {
    const table = players('Alice', 'Bob', 'Carol');
    let state = expectOk(
      play(
        makeState({
          players: table,
          hands: {
            'p-alice': cards('red:taki', 'red:direction', 'blue:3'),
            'p-bob': cards('red:1'),
            'p-carol': cards('red:3'),
          },
          discardPile: cards('red:9'),
        }),
        'p-alice',
        'red:taki',
      ),
    ).state;
    state = expectOk(play(state, 'p-alice', 'red:direction')).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(closed.state.direction).toBe(-1);
    expect(currentPlayer(closed.state)?.id).toBe('p-carol');
  });

  it('falls back to passing the turn when the discard pile is somehow empty', () => {
    const state = makeState({
      discardPile: [],
      activeColor: 'red',
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 1, openedWithSuperTaki: false },
    });
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
  });
});

describe('super taki', () => {
  it('takes the leading colour and opens a sequence in it', () => {
    const state = makeState({
      hands: { 'p-alice': cards('superTaki', 'red:3', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    // Since the King joined the deck, Super Taki no longer repaints the table.
    expectRejected(play(state, 'p-alice', 'superTaki', 'green'), 'colorNotAllowed');

    const { state: next, events } = expectOk(play(state, 'p-alice', 'superTaki'));
    expect(next.activeColor).toBe('red');
    expect(next.takiMode).toEqual({
      color: 'red',
      playerId: 'p-alice',
      cardsPlayed: 1,
      openedWithSuperTaki: true,
    });
    expect(eventTypes(events)).toEqual(['cardPlayed', 'takiOpened']);
    expect(events.find((event) => event.type === 'takiOpened')).toMatchObject({ superTaki: true });
  });

  it('lets the player continue in the leading colour', () => {
    let state = makeState({
      hands: { 'p-alice': cards('superTaki', 'green:3', 'green:stop', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('green:9'),
    });
    state = expectOk(play(state, 'p-alice', 'superTaki')).state;
    state = expectOk(play(state, 'p-alice', 'green:3')).state;
    expectRejected(play(state, 'p-alice', 'blue:3'), 'wrongTakiColor');
    state = expectOk(play(state, 'p-alice', 'green:stop')).state;
    expect(state.takiMode?.cardsPlayed).toBe(3);
  });

  it('is playable when the sequence stays a single card', () => {
    const state = expectOk(
      play(
        makeState({
          hands: { 'p-alice': cards('superTaki', 'blue:3'), 'p-bob': cards('red:1') },
          discardPile: cards('yellow:9'),
        }),
        'p-alice',
        'superTaki',
      ),
    ).state;
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(closed.state.activeColor).toBe('yellow');
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
  });
});
