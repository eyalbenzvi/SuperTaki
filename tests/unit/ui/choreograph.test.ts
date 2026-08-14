import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/features/game/engine/cards.ts';
import type { GameEvent, GameEventType } from '../../../src/features/game/engine/state.ts';
import type { Beat } from '../../../src/features/game/state/beat.ts';
import {
  CATCH_UP_LAG,
  DRAW_FLIGHT_CAP,
  DRAW_STAGGER_MS,
  PLAY_LOCAL_MS,
  PLAY_REMOTE_MS,
  REDUCED_MS,
  choreograph,
  cueFor,
  type ChoreographOptions,
  type Motion,
} from '../../../src/features/game/ui/choreograph.ts';

/**
 * Every decision about what animates lives in this one pure function, which is
 * the point: a table-driven test over the whole event vocabulary is possible
 * here and would not be possible if the same decisions were spread through the
 * view. The event union has 24 members and every one of them is named below —
 * including the nine that are deliberately silent, because "we chose not to
 * animate this" is a decision worth defending in a test rather than an omission.
 */

const ME = 'pl_me00000000';
const THEM = 'pl_them000000';
const THIRD = 'pl_third00000';

const CARD: Card = { id: 'n-red-5-0', kind: 'number', color: 'red', value: 5 };

function beatOf(events: readonly GameEvent[], seq = 5): Beat {
  return { seq, events };
}

function options(overrides: Partial<ChoreographOptions> = {}): ChoreographOptions {
  return {
    localPlayerId: ME,
    reducedMotion: false,
    inFlight: [],
    lastPlayedSeq: 4,
    ...overrides,
  };
}

function plan(events: readonly GameEvent[], overrides: Partial<ChoreographOptions> = {}): readonly Motion[] {
  return choreograph(beatOf(events), options(overrides));
}

describe('what each event is worth', () => {
  /*
   * One row per member of the union. `count` is how many motions the event is
   * worth on its own; zero means a considered silence. If the engine gains an
   * event, the exhaustiveness check at the bottom of this file fails until it is
   * given a row here.
   */
  const table: { event: GameEvent; count: number; note: string }[] = [
    {
      event: { type: 'gameStarted', firstPlayerId: THEM, activeColor: 'red' },
      count: 0,
      note: 'deals instantly',
    },
    {
      event: { type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' },
      count: 1,
      note: 'flies',
    },
    { event: { type: 'cardDrawn', playerId: THEM, count: 1 }, count: 1, note: 'flies' },
    {
      event: { type: 'takiOpened', playerId: THEM, color: 'red', superTaki: false },
      count: 0,
      note: 'bracketed by the plays inside it',
    },
    { event: { type: 'takiClosed', playerId: THEM, cardsPlayed: 3 }, count: 0, note: 'same' },
    {
      event: { type: 'colorChosen', playerId: THEM, color: 'blue' },
      count: 0,
      note: 'the colour rail already cross-fades',
    },
    { event: { type: 'playerSkipped', playerId: THEM }, count: 1, note: 'a Stop is felt at the seat' },
    { event: { type: 'drawStacked', playerId: THEM, total: 4 }, count: 1, note: 'escalates' },
    {
      event: { type: 'drawRunCancelled', playerId: THEM, cancelled: 4 },
      count: 1,
      note: 'the run dying, on the pile that grew it',
    },
    { event: { type: 'plusThreePlayed', playerId: THEM }, count: 1, note: 'threatens' },
    { event: { type: 'plusThreeBroken', playerId: THEM, targetId: THIRD }, count: 2, note: 'reverses' },
    { event: { type: 'lastCardDeclared', playerId: THEM }, count: 1, note: 'the shout' },
    {
      event: { type: 'lastCardCaught', playerId: THEM, caughtById: THIRD, penalty: 4 },
      count: 1,
      note: 'directional',
    },
    { event: { type: 'breakerSpent', playerId: THEM, penalty: 3 }, count: 1, note: 'costs its owner' },
    { event: { type: 'directionChanged', direction: -1 }, count: 1, note: 'sweeps' },
    { event: { type: 'extraTurn', playerId: THEM }, count: 1, note: 'a Plus goes again' },
    {
      event: { type: 'plusLastCardDrawn', playerId: THEM },
      count: 1,
      note: 'the hand that emptied on a Plus and had to take a card back',
    },
    {
      event: { type: 'turnChanged', playerId: THEM },
      count: 0,
      note: 'the banner and the seat ring carry this in CSS',
    },
    { event: { type: 'drawPileRecycled', count: 30 }, count: 1, note: 'the deck is rebuilt' },
    { event: { type: 'drawPileExhausted' }, count: 0, note: 'nothing to show' },
    { event: { type: 'playerWon', playerId: THEM }, count: 1, note: 'the payoff' },
    {
      event: { type: 'stairsAdvanced', playerId: THEM, stage: 3, dealt: 5 },
      count: 1,
      note: 'a step of the staircase, felt at the seat that took it',
    },
    { event: { type: 'turnSkipped', playerId: THEM, drew: 0 }, count: 1, note: 'somebody was away' },
    { event: { type: 'playerLeft', playerId: THEM }, count: 0, note: 'bookkeeping' },
    { event: { type: 'roundAbandoned' }, count: 0, note: 'the screen changes instead' },
  ];

  it('covers all 25 members of the event union', () => {
    const covered = new Set(table.map((row) => row.event.type));
    // Kept honest by a compile-time exhaustive map, below.
    expect(covered.size).toBe(25);
    expect(table).toHaveLength(25);
  });

  for (const row of table) {
    it(`${row.event.type}: ${row.count === 0 ? 'says nothing' : `${row.count} motion(s)`} — ${row.note}`, () => {
      expect(plan([row.event])).toHaveLength(row.count);
    });
  }

  it('names every event type, so a new one cannot be forgotten', () => {
    // A missing key is a type error, not a silent gap.
    const decided: Record<GameEventType, true> = {
      gameStarted: true,
      cardPlayed: true,
      cardDrawn: true,
      takiOpened: true,
      takiClosed: true,
      colorChosen: true,
      playerSkipped: true,
      drawStacked: true,
      drawRunCancelled: true,
      plusThreePlayed: true,
      plusThreeBroken: true,
      lastCardDeclared: true,
      lastCardCaught: true,
      breakerSpent: true,
      directionChanged: true,
      extraTurn: true,
      plusLastCardDrawn: true,
      turnChanged: true,
      drawPileRecycled: true,
      drawPileExhausted: true,
      playerWon: true,
      stairsAdvanced: true,
      turnSkipped: true,
      playerLeft: true,
      roundAbandoned: true,
    };
    expect(Object.keys(decided)).toHaveLength(25);
  });
});

describe('a card being played', () => {
  it("flies the card's own face from the seat that played it", () => {
    // The face, not a back: the discard has already committed the play, so a copy
    // of that card travelling onto the pile matches what is already there.
    const [motion] = plan([{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }]);
    expect(motion).toMatchObject({
      kind: 'flight',
      from: `seat:${THEM}`,
      to: 'pile:discard',
      card: CARD,
      durationMs: PLAY_REMOTE_MS,
    });
  });

  it('leaves my own hand from the slot it sat in, and quicker', () => {
    const [motion] = plan([{ type: 'cardPlayed', playerId: ME, card: CARD, resultingColor: 'red' }]);
    // Shorter because I already know what I did; the length would just be latency.
    expect(motion).toMatchObject({
      kind: 'flight',
      from: `slot:${CARD.id}`,
      durationMs: PLAY_LOCAL_MS,
    });
  });
});

describe('cards being drawn', () => {
  it('staggers them', () => {
    const motions = plan([{ type: 'cardDrawn', playerId: THEM, count: 3 }]);
    expect(motions.map((motion) => (motion.kind === 'flight' ? motion.delayMs : -1))).toEqual([
      0,
      DRAW_STAGGER_MS,
      DRAW_STAGGER_MS * 2,
    ]);
  });

  it('caps a big penalty, so ten cards do not become a cutscene', () => {
    for (const count of [1, 3, 4, 10, 20]) {
      const motions = plan([{ type: 'cardDrawn', playerId: THEM, count }]);
      expect(motions).toHaveLength(Math.min(count, DRAW_FLIGHT_CAP));
    }
  });

  it('lands in my hand when they are mine, since I have no seat on the table', () => {
    const [mine] = plan([{ type: 'cardDrawn', playerId: ME, count: 1 }]);
    expect(mine).toMatchObject({ to: 'hand' });
    const [theirs] = plan([{ type: 'cardDrawn', playerId: THEM, count: 1 }]);
    expect(theirs).toMatchObject({ to: `seat:${THEM}` });
  });

  it('never reveals a drawn card, not even to its owner', () => {
    const motions = plan([{ type: 'cardDrawn', playerId: ME, count: 2 }]);
    for (const motion of motions) {
      expect(motion).toMatchObject({ card: null });
    }
  });
});

describe('the +2 run', () => {
  it('lands harder as it grows, and stops growing before it becomes absurd', () => {
    const intensities = [2, 4, 6, 12, 40].map((total) => {
      const [motion] = plan([{ type: 'drawStacked', playerId: THEM, total }]);
      return motion?.kind === 'pulse' ? motion.intensity : -1;
    });
    // Monotonic and bounded.
    expect(intensities).toEqual([...intensities].sort((a, b) => a - b));
    expect(Math.max(...intensities)).toBeLessThanOrEqual(3);
    expect(Math.min(...intensities)).toBeGreaterThanOrEqual(1);
  });
});

describe('a +3 sent back', () => {
  it('is one continuous reversal: the second flight starts where the first ended', () => {
    const motions = plan([{ type: 'plusThreeBroken', playerId: THEM, targetId: THIRD }]);
    const [first, second] = motions;
    if (first?.kind !== 'flight' || second?.kind !== 'flight') {
      throw new Error('expected two flights');
    }
    expect(first.to).toBe(second.from);
    expect(second.to).toBe(`seat:${THIRD}`);
    // Ordered, not simultaneous, or it reads as two unrelated things happening.
    expect(second.delayMs).toBeGreaterThanOrEqual(first.durationMs);
  });

  it('anchors on my hand when the penalty comes back to me', () => {
    const motions = plan([{ type: 'plusThreeBroken', playerId: THEM, targetId: ME }]);
    const second = motions[1];
    expect(second).toMatchObject({ to: 'hand' });
  });
});

describe('a last card caught', () => {
  it('travels from whoever called it to whoever was caught', () => {
    const [motion] = plan([{ type: 'lastCardCaught', playerId: THEM, caughtById: THIRD, penalty: 4 }]);
    expect(motion).toMatchObject({ from: `seat:${THIRD}`, to: `seat:${THEM}` });
  });

  it('works when I am the caller, and when I am the one caught', () => {
    const [asCaller] = plan([{ type: 'lastCardCaught', playerId: THEM, caughtById: ME, penalty: 4 }]);
    expect(asCaller).toMatchObject({ from: 'hand', to: `seat:${THEM}` });

    const [asCaught] = plan([{ type: 'lastCardCaught', playerId: ME, caughtById: THEM, penalty: 4 }]);
    expect(asCaught).toMatchObject({ from: `seat:${THEM}`, to: 'hand' });
  });
});

describe('direction', () => {
  it('emits the logical sign, leaving the visual one to the view', () => {
    /*
     * This is the one place the architecture could hide an RTL bug: seating order
     * runs left-to-right in English and right-to-left in Hebrew, so a planner
     * that emitted a visual direction would test green while the sweep ran
     * backwards in the app's default language. It emits the rule's direction and
     * the view multiplies by the document's.
     */
    const [back] = plan([{ type: 'directionChanged', direction: -1 }]);
    expect(back).toMatchObject({ kind: 'sweep', direction: -1 });
    const [forward] = plan([{ type: 'directionChanged', direction: 1 }]);
    expect(forward).toMatchObject({ kind: 'sweep', direction: 1 });
  });
});

describe('the interruption rules', () => {
  it('never starts a motion that is already on screen', () => {
    const events: GameEvent[] = [{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }];
    const [motion] = plan(events);
    expect(motion).toBeDefined();

    // The same beat again — a host replaying its log, or the beat catching up
    // with a card already flying because the player tapped it.
    expect(plan(events, { inFlight: [motion?.key ?? ''] })).toHaveLength(0);
  });

  it('mints stable keys, so the same beat plans identically twice', () => {
    const events: GameEvent[] = [{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }];
    expect(plan(events).map((motion) => motion.key)).toEqual(plan(events).map((motion) => motion.key));
  });

  it('keeps distinct keys for distinct beats', () => {
    const events: GameEvent[] = [{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }];
    const early = choreograph({ ...beatOf(events, 5) }, options());
    const late = choreograph({ ...beatOf(events, 6) }, options({ lastPlayedSeq: 5 }));
    expect(early[0]?.key).not.toBe(late[0]?.key);
  });

  it('says only the essential thing when the player has outrun it', () => {
    const events: GameEvent[] = [
      { type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' },
      { type: 'playerSkipped', playerId: THIRD },
      { type: 'directionChanged', direction: -1 },
    ];
    expect(plan(events)).toHaveLength(3);

    // A run of cards is one command each, so falling behind is normal rather
    // than exceptional. Past the lag the commentary is dropped and the card
    // still lands.
    const behind = choreograph(beatOf(events, 20), options({ lastPlayedSeq: 20 - CATCH_UP_LAG - 1 }));
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ kind: 'flight', to: 'pile:discard' });
  });

  it('falls silent rather than inventing a cue when it is behind with nothing landing', () => {
    const behind = choreograph(
      beatOf([{ type: 'playerSkipped', playerId: THEM }], 20),
      options({ lastPlayedSeq: 10 }),
    );
    expect(behind).toEqual([]);
  });
});

describe('reduced motion', () => {
  const events: GameEvent[] = [
    { type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' },
    { type: 'directionChanged', direction: -1 },
  ];

  it('substitutes rather than empties, so the player still learns what happened', () => {
    const motions = plan(events, { reducedMotion: true });
    expect(motions).toHaveLength(2);
    expect(motions.every((motion) => motion.kind === 'pulse')).toBe(true);
  });

  it('collapses a flight onto where it was going', () => {
    const [motion] = plan([events[0] as GameEvent], { reducedMotion: true });
    expect(motion).toMatchObject({ kind: 'pulse', at: 'pile:discard', durationMs: REDUCED_MS });
  });

  it('collapses a sweep onto the seats it would have crossed', () => {
    const [motion] = plan([events[1] as GameEvent], { reducedMotion: true });
    expect(motion).toMatchObject({ kind: 'pulse', at: 'seats', durationMs: REDUCED_MS });
  });

  it('shortens a pulse and drops its delay', () => {
    const [motion] = plan([{ type: 'cardDrawn', playerId: THEM, count: 2 }], { reducedMotion: true });
    expect(motion).toMatchObject({ delayMs: 0, durationMs: REDUCED_MS });
  });

  it('is never overridden by the catch-up rule', () => {
    // Both conditions at once: the preference wins, because dropping to a single
    // motion would be a second, quieter way of ignoring it.
    const motions = choreograph(beatOf(events, 30), options({ reducedMotion: true, lastPlayedSeq: 1 }));
    expect(motions).toHaveLength(2);
  });
});

describe('purity', () => {
  it('does not mutate the beat or the options it is given', () => {
    const events: GameEvent[] = [{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }];
    const beat = beatOf(events);
    const opts = options();
    const beatBefore = JSON.stringify(beat);
    const optsBefore = JSON.stringify(opts);

    choreograph(beat, opts);

    expect(JSON.stringify(beat)).toBe(beatBefore);
    expect(JSON.stringify(opts)).toBe(optsBefore);
  });

  it('returns the same plan for the same inputs', () => {
    const events: GameEvent[] = [{ type: 'cardDrawn', playerId: THEM, count: 3 }];
    expect(plan(events)).toEqual(plan(events));
  });
});

describe('what each event is worth in sound', () => {
  /*
   * Sound answers a different question from motion: motion says where something
   * happened, sound says that something happened *to me*. Seven of the twenty-four
   * events make a noise; the sixteen silences below are decisions, not omissions.
   */
  function cue(events: readonly GameEvent[], me: string | null = ME): ReturnType<typeof cueFor> {
    return cueFor(beatOf(events), me);
  }

  it('says nothing for the sixteen events that are deliberately silent', () => {
    const silent: GameEvent[] = [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: 'red' },
      { type: 'takiOpened', playerId: THEM, color: 'red', superTaki: false },
      { type: 'takiClosed', playerId: THEM, cardsPlayed: 3 },
      { type: 'colorChosen', playerId: THEM, color: 'blue' },
      { type: 'playerSkipped', playerId: THEM },
      // The King that cancelled the run is a `cardPlayed` in the same beat, and
      // that already makes the sound. A second one for the relief is noise.
      { type: 'drawRunCancelled', playerId: THEM, cancelled: 4 },
      { type: 'plusThreePlayed', playerId: THEM },
      { type: 'plusThreeBroken', playerId: THEM, targetId: THIRD },
      { type: 'breakerSpent', playerId: THEM, penalty: 3 },
      { type: 'directionChanged', direction: -1 },
      { type: 'extraTurn', playerId: THEM },
      { type: 'drawPileRecycled', count: 30 },
      { type: 'drawPileExhausted' },
      { type: 'turnSkipped', playerId: THEM, drew: 0 },
      { type: 'playerLeft', playerId: THEM },
      { type: 'roundAbandoned' },
    ];
    expect(silent).toHaveLength(16);
    for (const event of silent) {
      expect(cue([event]), event.type).toBeNull();
    }
  });

  it('is silent when somebody else draws', () => {
    // Several times a minute. A sound at that frequency stops being information.
    expect(cue([{ type: 'cardDrawn', playerId: THEM, count: 1 }])).toBeNull();
  });

  it('speaks for the seven that matter', () => {
    expect(cue([{ type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' }])).toBe('play');
    expect(cue([{ type: 'cardDrawn', playerId: ME, count: 1 }])).toBe('draw');
    expect(cue([{ type: 'turnChanged', playerId: ME }])).toBe('yourTurn');
    expect(cue([{ type: 'drawStacked', playerId: THEM, total: 4 }])).toBe('penalty');
    expect(cue([{ type: 'lastCardDeclared', playerId: THEM }])).toBe('lastCard');
    expect(cue([{ type: 'lastCardCaught', playerId: ME, caughtById: THEM, penalty: 4 }])).toBe('caught');
    expect(cue([{ type: 'playerWon', playerId: THEM }])).toBe('win');
  });

  it('tells a turn taken from a penalty paid', () => {
    // One or two cards is a turn. Three or more is a penalty, and sounds like one.
    expect(cue([{ type: 'cardDrawn', playerId: ME, count: 1 }])).toBe('draw');
    expect(cue([{ type: 'cardDrawn', playerId: ME, count: 2 }])).toBe('draw');
    expect(cue([{ type: 'cardDrawn', playerId: ME, count: 4 }])).toBe('penalty');
  });

  it('says nothing about somebody else becoming the current player', () => {
    expect(cue([{ type: 'turnChanged', playerId: THEM }])).toBeNull();
  });

  it('makes one sound per beat, not one per event', () => {
    /*
     * A catch is immediately followed by the draw it caused, and a win by the turn
     * that never happens. Two sounds at once is a mess rather than twice the
     * information, so the most important one wins.
     */
    expect(
      cue([
        { type: 'lastCardCaught', playerId: ME, caughtById: THEM, penalty: 4 },
        { type: 'cardDrawn', playerId: ME, count: 4 },
      ]),
    ).toBe('caught');
    expect(
      cue([
        { type: 'cardPlayed', playerId: THEM, card: CARD, resultingColor: 'red' },
        { type: 'playerWon', playerId: THEM },
      ]),
    ).toBe('win');
  });

  it('needs to know who I am before it can say a turn is mine', () => {
    expect(cue([{ type: 'turnChanged', playerId: ME }], null)).toBeNull();
  });
});
