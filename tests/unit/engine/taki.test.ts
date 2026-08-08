import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  currentPlayer,
  playContextFromState,
  topCard,
} from '../../../src/features/game/engine/engine.ts';
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
      takisOnly: true,
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
      takiSwitchOpen: next.takiMode?.takisOnly ?? false,
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

  it('carries the sequence into a taki of another colour, but nothing else', () => {
    const state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'blue:taki', 'blue:3', 'red:3'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    const next = expectOk(play(state, 'p-alice', 'red:taki')).state;

    // An ordinary card of another colour is refused, as ever.
    expectRejected(play(next, 'p-alice', 'blue:3'), 'wrongTakiColor');
    // A Taki is not ordinary: laid straight onto the Taki, it takes the run over.
    expect(getPlayableCardIds(next.hands['p-alice'] ?? [], playContextFromState(next)).sort()).toEqual(
      (next.hands['p-alice'] ?? [])
        .filter((card) => card.id.startsWith('red:3#') || card.id.startsWith('blue:taki#'))
        .map((card) => card.id)
        .sort(),
    );

    const after = expectOk(play(next, 'p-alice', 'blue:taki')).state;
    expect(after.takiMode?.color).toBe('blue');
    expect(after.activeColor).toBe('blue');
    expect(after.takiMode?.cardsPlayed).toBe(2);
    expect(currentPlayer(after)?.id).toBe('p-alice');

    // From here the run is blue: the blue card plays, the red one no longer does.
    expectRejected(play(after, 'p-alice', 'red:3'), 'wrongTakiColor');
    const blue = expectOk(play(after, 'p-alice', 'blue:3')).state;
    expect(blue.takiMode?.color).toBe('blue');
    expect(blue.takiMode?.cardsPlayed).toBe(3);
  });

  it('closes the colour once an ordinary card joins the run', () => {
    /*
     * The line the rule draws, in the reporter's own example: a red Taki, red
     * numbers on it, another red Taki — and then a yellow one, which is refused.
     * The top card is a Taki with nothing on it, but the *run* is no longer only
     * Takis, and that is what the switch depends on.
     */
    let state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'red:3', 'red:taki', 'yellow:taki'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    expect(state.takiMode?.takisOnly).toBe(true);

    state = expectOk(play(state, 'p-alice', 'red:3')).state;
    expect(state.takiMode?.takisOnly).toBe(false);

    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    // Still false: a Taki cannot reopen a settled colour, however it is stacked.
    expect(state.takiMode?.takisOnly).toBe(false);
    expect(topCard(state)?.kind).toBe('taki');

    expectRejected(play(state, 'p-alice', 'yellow:taki'), 'wrongTakiColor');
    expect(state.takiMode?.color).toBe('red');
    expect(state.activeColor).toBe('red');
  });

  it('lets the colour be carried more than once while only takis are down', () => {
    let state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'blue:taki', 'green:taki', 'green:5', 'green:9'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    state = expectOk(play(state, 'p-alice', 'blue:taki')).state;
    state = expectOk(play(state, 'p-alice', 'green:taki')).state;

    expect(state.takiMode?.color).toBe('green');
    expect(state.takiMode?.takisOnly).toBe(true);
    expect(state.takiMode?.cardsPlayed).toBe(3);

    // And the run finishes in the colour it was carried into.
    state = expectOk(play(state, 'p-alice', 'green:5')).state;
    expect(state.takiMode?.color).toBe('green');
    const closed = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' }));
    expect(closed.state.activeColor).toBe('green');
    expect(currentPlayer(closed.state)?.id).toBe('p-bob');
  });

  it('lets a Super Taki join the run, leaving the colour where it is', () => {
    // A coloured Taki is legal on top of a Super Taki, so a Super Taki has to be
    // legal on top of a Taki. It has no colour of its own, so unlike a coloured
    // one it carries nothing: the run stays red.
    let state = makeState({
      hands: { 'p-alice': cards('red:taki', 'superTaki', 'red:3', 'red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    expect(state.takiMode?.takisOnly).toBe(true);

    state = expectOk(play(state, 'p-alice', 'superTaki')).state;
    expect(state.takiMode?.color).toBe('red');
    expect(state.activeColor).toBe('red');
    expect(state.takiMode?.takisOnly).toBe(true);
    expect(state.takiMode?.cardsPlayed).toBe(2);

    // And the run carries on in that colour, as any Taki run does.
    state = expectOk(play(state, 'p-alice', 'red:3')).state;
    expect(state.takiMode?.takisOnly).toBe(false);
  });

  it('lets a Super Taki land on a Super Taki, and a coloured Taki carry both', () => {
    let state = makeState({
      hands: {
        'p-alice': cards('superTaki', 'superTaki', 'blue:taki', 'blue:5', 'blue:6'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'superTaki')).state;
    expect(state.takiMode?.color).toBe('red');

    state = expectOk(play(state, 'p-alice', 'superTaki')).state;
    expect(state.takiMode?.color).toBe('red');
    expect(state.takiMode?.openedWithSuperTaki).toBe(true);

    // The coloured one is the only card here with a colour to give, so it is the
    // one that moves the run.
    state = expectOk(play(state, 'p-alice', 'blue:taki')).state;
    expect(state.takiMode?.color).toBe('blue');
    expect(state.takiMode?.openedWithSuperTaki).toBe(false);
    expect(state.takiMode?.takisOnly).toBe(true);
    state = expectOk(play(state, 'p-alice', 'blue:5')).state;
    expect(state.takiMode?.color).toBe('blue');
  });

  it('shuts a Super Taki out once an ordinary card has settled the run', () => {
    // The same limit the coloured Taki has: the permission hangs on the run, and
    // the run stopped being nothing but Takis.
    let state = makeState({
      hands: { 'p-alice': cards('red:taki', 'red:3', 'superTaki'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    state = expectOk(play(state, 'p-alice', 'red:3')).state;
    expect(state.takiMode?.takisOnly).toBe(false);
    expectRejected(play(state, 'p-alice', 'superTaki'), 'wildNotAllowedInTaki');
  });

  it('still refuses every other colourless card, however early', () => {
    const state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'colorChange', 'king', 'plusThree', 'breakPlusThree'),
        'p-bob': cards('red:1'),
      },
      discardPile: cards('red:9'),
    });
    const next = expectOk(play(state, 'p-alice', 'red:taki')).state;
    expect(next.takiMode?.takisOnly).toBe(true);
    for (const spec of ['king', 'plusThree', 'breakPlusThree']) {
      expectRejected(play(next, 'p-alice', spec), 'wildNotAllowedInTaki');
    }
    // Change Colour is asked for its colour first, and refused on the colour it names.
    expectRejected(play(next, 'p-alice', 'colorChange', 'red'), 'wildNotAllowedInTaki');
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
      takisOnly: true,
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
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 1,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
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
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 1,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
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
      takisOnly: true,
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

  it('accepts a coloured Taki from the next player once it is the top card', () => {
    /*
     * The whole reported sequence, played out: Bob opens with a Super Taki on a red
     * table, closes it straight away, and Alice — holding a yellow Taki and nothing
     * red — is told she has no legal card. She has: the pile says TAKI.
     */
    let state = makeState({
      hands: { 'p-alice': cards('yellow:taki', 'blue:stop'), 'p-bob': cards('superTaki', 'red:1') },
      discardPile: cards('red:9'),
      currentPlayerIndex: 1,
    });
    state = expectOk(play(state, 'p-bob', 'superTaki')).state;
    state = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-bob' })).state;

    expect(currentPlayer(state)?.id).toBe('p-alice');
    expect(state.activeColor).toBe('red');
    const yellowTaki = (state.hands['p-alice'] ?? []).find((card) => card.kind === 'taki');
    expect(getPlayableCardIds(state.hands['p-alice'] ?? [], playContextFromState(state))).toEqual([
      yellowTaki?.id,
    ]);

    // And it plays: a Taki is a Taki, so it opens a yellow sequence of her own.
    const played = expectOk(play(state, 'p-alice', 'yellow:taki'));
    expect(played.state.activeColor).toBe('yellow');
    expect(played.state.takiMode).toMatchObject({ color: 'yellow', playerId: 'p-alice' });
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
