import type { Card } from '../engine/cards.ts';
import type { GameEvent, PlayerId, TurnDirection } from '../engine/state.ts';
import type { Cue } from '../../../lib/audio.ts';
import type { Beat } from '../state/beat.ts';

/**
 * Where a motion starts or ends.
 *
 * A player's own seat is deliberately not addressable: `opponents()` filters the
 * local player out, so `.seats__list` contains no element for them and
 * `seat:<me>` would never resolve. Anything happening to me is anchored on my
 * hand instead, which is both present and the thing I am looking at.
 */
export type AnchorId = 'hand' | 'seats' | 'pile:draw' | 'pile:discard' | `seat:${string}` | `slot:${string}`;

export interface Flight {
  readonly kind: 'flight';
  readonly key: string;
  readonly from: AnchorId;
  readonly to: AnchorId;
  /** The face to show, or `null` for a card whose identity is not ours to know. */
  readonly card: Card | null;
  readonly delayMs: number;
  readonly durationMs: number;
}

export interface Pulse {
  readonly kind: 'pulse';
  readonly key: string;
  readonly at: AnchorId;
  readonly tone: 'danger' | 'success' | 'neutral';
  /** 1–3. Steps with the stake, so a fourth +2 lands harder than the first. */
  readonly intensity: number;
  readonly delayMs: number;
  readonly durationMs: number;
}

export interface Sweep {
  readonly kind: 'sweep';
  readonly key: string;
  /**
   * The *logical* direction: `1` follows the seating order.
   *
   * Not a visual direction. Seating order runs left-to-right in English and
   * right-to-left in Hebrew, so the view multiplies this by the document
   * direction. Emitting a visual sign here would produce a planner test that
   * passes while the sweep runs backwards in the app's default language.
   */
  readonly direction: TurnDirection;
  readonly durationMs: number;
}

export type Motion = Flight | Pulse | Sweep;

export interface ChoreographOptions {
  readonly localPlayerId: PlayerId | null;
  /**
   * Passed in, never read from `matchMedia` here.
   *
   * A planner that reads a global is impure, untestable without stubbing that
   * global, and — being called while rendering — trips `react-hooks/purity`.
   */
  readonly reducedMotion: boolean;
  /** Keys already on screen. A motion is never started twice for one card. */
  readonly inFlight: readonly string[];
  /** The newest beat the view has actually played, for the catch-up rule. */
  readonly lastPlayedSeq: number;
}

/* Timings. Named because the tests assert them and the view obeys them. */
export const PLAY_REMOTE_MS = 240;
export const PLAY_LOCAL_MS = 170;
export const DRAW_MS = 200;
export const DRAW_STAGGER_MS = 45;
/** A ten-card penalty flies four cards, not ten. */
export const DRAW_FLIGHT_CAP = 4;
export const PULSE_MS = 220;
export const DECLARE_MS = 120;
export const SWEEP_MS = 280;
export const RECYCLE_MS = 420;
export const WIN_MS = 380;
/** Opacity-only stand-in used when the player has asked for less motion. */
export const REDUCED_MS = 150;

/**
 * How far behind the view may fall before it stops telling the whole story.
 *
 * A Taki run is one accepted command per card, so six cards is six beats and six
 * chances to fall behind. Past this the plan is cut to the single motion that
 * keeps the table honest, which is what "fly the first and last card of a run and
 * skip the middle" amounts to in practice.
 */
export const CATCH_UP_LAG = 2;

/**
 * Which sound one accepted command is worth, if any.
 *
 * Pure and separate from the motion plan, because sound answers a different
 * question: motion says *where* something happened, sound says *that something
 * happened to me*. Seven of the twenty-five events make a noise. The rest are
 * silent on purpose — an opponent's draw happens several times a minute and would
 * become wallpaper, and an illegal card says nothing at all, because a buzzer for a
 * mistap is punishment for a UI we designed.
 *
 * At most one cue per beat, in priority order: a beat can contain a catch *and* the
 * draw it caused, and two sounds at once is a mess rather than twice the
 * information.
 */
export function cueFor(beat: Beat, localPlayerId: PlayerId | null): Cue | null {
  const mine = (id: PlayerId): boolean => id === localPlayerId;
  let sawDraw = false;
  let sawPlay = false;

  for (const event of beat.events) {
    switch (event.type) {
      case 'playerWon':
        return 'win';
      case 'lastCardCaught':
        // Loudest thing at a real table, and it matters to everyone, not just the
        // two people involved.
        return 'caught';
      case 'drawStacked':
        return 'penalty';
      case 'cardDrawn':
        if (mine(event.playerId)) {
          // Four or more cards is a penalty being paid, not a turn being taken.
          return event.count >= 3 ? 'penalty' : 'draw';
        }
        sawDraw = true;
        break;
      case 'lastCardDeclared':
        return 'lastCard';
      case 'cardPlayed':
        sawPlay = true;
        break;
      case 'turnChanged':
        if (mine(event.playerId)) {
          return 'yourTurn';
        }
        break;
      default:
        break;
    }
  }

  if (sawPlay) {
    return 'play';
  }
  /*
   * Somebody else drawing is deliberately silent. It happens several times a
   * minute, it is already in the log and on their seat, and at that frequency a
   * sound stops carrying information and becomes wallpaper.
   */
  void sawDraw;
  return null;
}

/** Anything happening to me is anchored on my hand; there is no seat for me. */
function seatAnchor(playerId: PlayerId, localPlayerId: PlayerId | null): AnchorId {
  return playerId === localPlayerId ? 'hand' : `seat:${playerId}`;
}

function pulse(
  key: string,
  at: AnchorId,
  tone: Pulse['tone'],
  options: { intensity?: number; delayMs?: number; durationMs?: number } = {},
): Pulse {
  return {
    kind: 'pulse',
    key,
    at,
    tone,
    intensity: options.intensity ?? 1,
    delayMs: options.delayMs ?? 0,
    durationMs: options.durationMs ?? PULSE_MS,
  };
}

/** Motions for one event, before the interruption rules are applied. */
function motionsFor(event: GameEvent, seq: number, options: ChoreographOptions): Motion[] {
  const me = options.localPlayerId;
  const id = (suffix: string): string => `${seq}:${suffix}`;

  switch (event.type) {
    case 'cardPlayed': {
      const mine = event.playerId === me;
      return [
        {
          kind: 'flight',
          key: id(`play:${event.card.id}`),
          from: mine ? `slot:${event.card.id}` : seatAnchor(event.playerId, me),
          to: 'pile:discard',
          card: event.card,
          // The card's own face flies, from my hand or from the seat that played
          // it. It matches what the discard already shows — the authoritative DOM
          // has committed the play before the flight starts — so a copy of that
          // card travelling onto the pile reads cleanly as "they played this". An
          // earlier design flew a face-down back and flipped it mid-air; that only
          // made sense against a pile that had *not* yet updated, which this
          // architecture never leaves it, so the flip was cut with these lines.
          delayMs: 0,
          durationMs: mine ? PLAY_LOCAL_MS : PLAY_REMOTE_MS,
        },
      ];
    }

    case 'cardDrawn': {
      const flights: Motion[] = [];
      const shown = Math.min(event.count, DRAW_FLIGHT_CAP);
      for (let index = 0; index < shown; index += 1) {
        flights.push({
          kind: 'flight',
          key: id(`draw:${event.playerId}:${index}`),
          from: 'pile:draw',
          to: seatAnchor(event.playerId, me),
          // A drawn card is face down to everyone, including its owner: they
          // learn it from their hand, not from watching it travel.
          card: null,
          delayMs: index * DRAW_STAGGER_MS,
          durationMs: DRAW_MS,
        });
      }
      return flights;
    }

    case 'drawStacked':
      // The run escalating is the most dramatic recurring moment in the game.
      // `total` is what the next player now owes, so the cue grows with it.
      return [
        pulse(id('stack'), 'pile:discard', 'danger', {
          intensity: Math.min(3, Math.max(1, Math.ceil(event.total / 4))),
        }),
      ];

    case 'drawRunCancelled':
      /*
       * The mirror of the stack, and it belongs on the same anchor: the pile has
       * been pulsing danger as the run grew, so the run dying is that same pile
       * going the other way. Intensity does not scale with the run — the relief is
       * the same size whether two cards or ten just evaporated.
       */
      return [pulse(id('runCancelled'), 'pile:discard', 'success', { intensity: 2 })];

    case 'plusThreePlayed':
      return [pulse(id('plusThree'), seatAnchor(event.playerId, me), 'danger', { intensity: 2 })];

    case 'plusThreeBroken':
      /*
       * One continuous reversal rather than two unrelated flights: the penalty
       * arrives at whoever holds the breaker, then turns around. This is the one
       * card interaction nobody understands on first sight, and a motion that
       * visibly comes back is the clearest reading of "sent back at you".
       */
      return [
        {
          kind: 'flight',
          key: id(`break:in:${event.playerId}`),
          from: 'pile:discard',
          to: seatAnchor(event.playerId, me),
          card: null,
          delayMs: 0,
          durationMs: PULSE_MS,
        },
        {
          kind: 'flight',
          key: id(`break:out:${event.targetId}`),
          from: seatAnchor(event.playerId, me),
          to: seatAnchor(event.targetId, me),
          card: null,
          delayMs: PULSE_MS,
          durationMs: PULSE_MS,
        },
      ];

    case 'breakerSpent':
      return [pulse(id('breakerSpent'), seatAnchor(event.playerId, me), 'danger')];

    case 'lastCardDeclared':
      return [
        pulse(id(`declared:${event.playerId}`), seatAnchor(event.playerId, me), 'success', {
          durationMs: DECLARE_MS,
        }),
      ];

    case 'lastCardCaught':
      // Directional on purpose: the catch is a social act, and who called it is
      // half of what happened. The penalty travels from the caller to the caught.
      return [
        {
          kind: 'flight',
          key: id(`caught:${event.playerId}`),
          from: seatAnchor(event.caughtById, me),
          to: seatAnchor(event.playerId, me),
          card: null,
          delayMs: 0,
          durationMs: PLAY_REMOTE_MS,
        },
      ];

    case 'playerSkipped':
      return [pulse(id(`skipped:${event.playerId}`), seatAnchor(event.playerId, me), 'neutral')];

    case 'turnSkipped':
      return [pulse(id(`away:${event.playerId}`), seatAnchor(event.playerId, me), 'neutral')];

    case 'extraTurn':
      return [pulse(id(`extra:${event.playerId}`), seatAnchor(event.playerId, me), 'success')];

    case 'directionChanged':
      return [{ kind: 'sweep', key: id('direction'), direction: event.direction, durationMs: SWEEP_MS }];

    case 'drawPileRecycled':
      // Genuinely dramatic at a real table, and until now a line in the log.
      return [
        {
          kind: 'flight',
          key: id('recycle'),
          from: 'pile:discard',
          to: 'pile:draw',
          card: null,
          delayMs: 0,
          durationMs: RECYCLE_MS,
        },
      ];

    case 'playerWon':
      return [
        pulse(id(`won:${event.playerId}`), seatAnchor(event.playerId, me), 'success', {
          intensity: 3,
          durationMs: WIN_MS,
        }),
      ];

    /*
     * A step of the staircase: the same shape as a win, quieter, because there are
     * seven of them before the one that ends the round.
     *
     * No flights for the cards that arrive. The engine folds the deal into this
     * event and drops its `cardDrawn`, so there is nothing here to fly from — and
     * eight cards crossing the screen would bury the moment they belong to. It makes
     * no sound of its own either: a step always lands in the same beat as the card
     * that caused it, and that card is already audible.
     */
    case 'stairsAdvanced':
      return [
        pulse(id(`stairs:${event.playerId}:${event.stage}`), seatAnchor(event.playerId, me), 'success', {
          intensity: 2,
        }),
      ];

    /*
     * Deliberately silent.
     *
     * `colorChosen` repaints the table, and the colour rail
     * around the discard pile already cross-fades — animating them again would be
     * two answers to one question. `takiOpened` and `takiClosed` are bracketed by
     * the `cardPlayed` events that caused them. `plusRefilled` always lands in the
     * same beat as the `cardDrawn` it explains, and that draw already flies a card
     * to the seat. `gameStarted` deals instantly on purpose: a dealing animation
     * looks magnificent once and costs two seconds before every round of a game
     * people play five rounds of. The rest are bookkeeping with nothing to show.
     */
    case 'plusRefilled':
    case 'gameStarted':
    case 'takiOpened':
    case 'takiClosed':
    case 'colorChosen':
    case 'turnChanged':
    case 'drawPileExhausted':
    case 'playerLeft':
    case 'roundAbandoned':
      return [];
  }
}

/** Collapses a motion to the opacity-only cue its destination can still show. */
function reduce(motion: Motion): Motion {
  if (motion.kind === 'flight') {
    return pulse(motion.key, motion.to, 'neutral', { durationMs: REDUCED_MS });
  }
  if (motion.kind === 'sweep') {
    return pulse(motion.key, 'seats', 'neutral', { durationMs: REDUCED_MS });
  }
  return { ...motion, delayMs: 0, durationMs: REDUCED_MS };
}

/**
 * Turns one accepted command into the motions that describe it.
 *
 * Pure: no DOM, no React, no global read, no clock. Every decision about what
 * animates lives here, which is what makes "does a +3 answered by a breaker
 * produce a reversal" an assertion rather than something checked by playing.
 */
export function choreograph(beat: Beat, options: ChoreographOptions): readonly Motion[] {
  const planned = beat.events.flatMap((event) => motionsFor(event, beat.seq, options));

  /*
   * Never started twice for the same card. This is what lets a played card fly
   * optimistically the instant it is tapped and still be described by the beat
   * that arrives forty milliseconds later: the beat's motion is dropped because
   * a clone already owns that card. It is also what makes a replayed beat
   * harmless.
   */
  const fresh = planned.filter((motion) => !options.inFlight.includes(motion.key));

  if (options.reducedMotion) {
    // Substituted, never emptied: the comprehension the motion was buying has
    // to survive the preference, or the preference costs the player the game.
    return fresh.map(reduce);
  }

  /*
   * Behind the game: say the one thing that keeps the table honest and drop the
   * commentary, rather than queueing a plan the player has already outrun.
   */
  if (beat.seq - options.lastPlayedSeq > CATCH_UP_LAG) {
    const landing = fresh.find((motion) => motion.kind === 'flight' && motion.to === 'pile:discard');
    return landing ? [landing] : [];
  }

  return fresh;
}
