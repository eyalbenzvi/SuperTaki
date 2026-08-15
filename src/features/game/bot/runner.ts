import { anyAssisted } from '../engine/assist.ts';
import type { PlayerId } from '../engine/state.ts';
import {
  BOT_ANSWER_MAX_MS,
  BOT_ANSWER_MIN_MS,
  BOT_CATCH_MAX_MS,
  BOT_CATCH_MIN_MS,
  BOT_DECLARE_MAX_MS,
  BOT_DECLARE_MIN_MS,
  BOT_SEQUENCE_MAX_MS,
  BOT_SEQUENCE_MIN_MS,
  BOT_SOFT_DECLARE_MAX_MS,
  BOT_SOFT_DECLARE_MIN_MS,
  BOT_THINK_MAX_MS,
  BOT_THINK_MIN_MS,
} from '../network/timing.ts';
import { chooseBotMove, type BotMove, type BotMoveKind } from './policy.ts';
import type { BotView } from './view.ts';

/**
 * The driver: everything about robots that is not a decision.
 *
 * It owns exactly one pause at a time, re-decides when that pause is over, and knows
 * how to stop asking for a move the table has already refused. It holds no game state
 * of its own — the state is the room's, and every move goes back through the room's
 * ordinary authoritative path, where it is refused exactly what a player would be.
 *
 * Both the pause and the randomness are injected, so a test can run a whole round in
 * one synchronous pump and get the same round every time — and so the room can arm a
 * pause as a Durable Object alarm rather than a timer it would not live to see fire.
 */

/** Cancels a pending pause. */
export type CancelPause = () => void;

export interface BotRunnerOptions {
  /** What this robot is allowed to know, or `null` when it owes nothing at all. */
  readonly view: (playerId: PlayerId) => BotView | null;
  /**
   * Seats a robot is playing right now, in seat order, and whose they are.
   *
   * `standIn` distinguishes a robot's own seat from a human's that it is covering,
   * which changes exactly one thing: how long it waits before declaring a last card.
   */
  readonly controlled: () => readonly { readonly playerId: PlayerId; readonly standIn: boolean }[];
  /** True while nothing may be played: no round, a paused table, a dead session. */
  readonly blocked: () => boolean;
  /**
   * Applies a move. `false` means the table refused it — the room is the authority on
   * the moves a robot cannot see the whole of, notably a catch — and the duty is then
   * dropped until the state moves on, rather than asked for again on a loop.
   */
  readonly submit: (playerId: PlayerId, move: BotMove) => boolean;
  /** Deterministic per-seat randomness; advances that seat's own stream. */
  readonly random: (playerId: PlayerId) => number;
  /**
   * How a pause is armed. Required, and deliberately so.
   *
   * There used to be a `setTimeout` default here, for the browser that used to run
   * this. The only caller is the room now, where a pause is a Durable Object alarm —
   * so a default that quietly used a timer would be a timer in an object that is
   * about to be evicted from memory, which is to say a pause that never ends.
   */
  readonly schedule: (run: () => void, ms: number) => CancelPause;
  /** Pause override, so a test does not have to wait for a human-shaped delay. */
  readonly pauseMs?: (kind: BotMoveKind, inSequence: boolean) => number;
}

interface Duty {
  readonly playerId: PlayerId;
  readonly move: BotMove;
  readonly version: number;
  /** Identity of this exact move at this exact state, used for both dedupe and suppression. */
  readonly key: string;
  /** How long to wait before making it, drawn once with the decision. */
  readonly pause: number;
}

/**
 * Which duty goes first when several seats owe something.
 *
 * Answering a +3 unfreezes the whole table, so it leads. A declaration comes next
 * even though it is not a turn: it is free, it cannot block anybody, and ranking it
 * *below* another seat's turn left a robot sitting on an undeclared last card
 * through every intervening move — exposure the declare pause exists to bound.
 * Calling somebody out comes last, so the people at the table get there first.
 */
const KIND_RANK: Readonly<Record<BotMoveKind, number>> = {
  breaker: 0,
  declare: 1,
  turn: 2,
  catch: 3,
};

/**
 * Where a duty sits in the queue.
 *
 * A declaration with no pause at all goes first, ahead even of a +3 answer: there is
 * nothing to wait for, and every moment it waits is a moment that seat can be called
 * out for four cards it never risked. That is always true of a seat a robot is
 * merely covering, and true of its own whenever the jitter lands on nought.
 * Everything else follows the ordinary order.
 */
function rankOf(duty: Duty): number {
  if (duty.move.kind === 'declare' && duty.pause <= 0) {
    return -1;
  }
  return KIND_RANK[duty.move.kind];
}

function keyFor(playerId: PlayerId, version: number, move: BotMove): string {
  const action = move.action;
  const detail =
    action.type === 'playCard'
      ? `${action.cardId}:${action.chosenColor ?? '-'}`
      : action.type === 'catchLastCard'
        ? action.targetId
        : '';
  return `${playerId}|${String(version)}|${action.type}|${detail}`;
}

export class BotRunner {
  private pending: { key: string; cancel: CancelPause } | null = null;
  /** Moves the table refused, and the state version they were refused at. */
  private refused = new Set<string>();
  private refusedAt = -1;
  /**
   * One decision per seat per state, kept until the state moves on.
   *
   * Not an optimisation. `schedule()` runs after every accepted command and whenever
   * a seat changes hands, and a decision draws from that seat's random stream — so
   * re-deciding speculatively both *changed* the answer whenever two cards scored
   * alike and advanced a stream the room's determinism is defined by. A robot on a
   * busy table would restart its own pause indefinitely and never reach the end of
   * one. The pause is drawn once here too, for the same reason.
   */
  private readonly decided = new Map<PlayerId, { version: number; move: BotMove | null; pause: number }>();
  private destroyed = false;

  constructor(private readonly options: BotRunnerOptions) {}

  /**
   * Re-reads the table and arms at most one pause.
   *
   * Safe to call as often as anything changes — after every accepted command, on any
   * alarm, whenever a seat changes hands. An identical duty that is
   * already waiting is left alone, so a burst of snapshots does not reset the
   * pause a robot is already in the middle of.
   */
  schedule(): void {
    if (this.destroyed) {
      return;
    }
    if (this.options.blocked()) {
      this.cancel();
      return;
    }
    const duty = this.nextDuty();
    if (!duty) {
      this.cancel();
      return;
    }
    if (this.pending?.key === duty.key) {
      return;
    }
    this.cancel();
    const key = duty.key;
    this.pending = {
      key,
      cancel: this.options.schedule(() => {
        this.pump();
      }, duty.pause),
    };
  }

  /** Drops any pause without ending the runner. */
  cancel(): void {
    if (this.pending) {
      this.pending.cancel();
      this.pending = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
    this.decided.clear();
  }

  /**
   * The pause is over. Decide again.
   *
   * Re-deciding rather than replaying is the point: a human may have caught
   * somebody, answered a +3 or come back to their seat while the robot was
   * "thinking", and a move computed against the older table could be illegal, or
   * legal and wrong.
   *
   * Public because the pause is not a closure this object gets to keep. A pause is a
   * Durable Object alarm, and an alarm wakes an object that may have been evicted from
   * memory in the meantime — so there is no callback left to call, only a deadline
   * that has passed and a room to re-read. That is exactly what this does: forget the
   * pause, look again, act.
   */
  pump(): void {
    this.pending = null;
    if (this.destroyed || this.options.blocked()) {
      return;
    }
    const duty = this.nextDuty();
    if (!duty) {
      return;
    }
    if (this.options.submit(duty.playerId, duty.move)) {
      // Accepted: the room re-arms from its own commit path, which knows the new
      // state. Doing it here as well would race that.
      return;
    }
    this.remember(duty);
    // Another seat may still owe something the table will accept.
    this.schedule();
  }

  private remember(duty: Duty): void {
    if (this.refusedAt !== duty.version) {
      this.refused.clear();
      this.refusedAt = duty.version;
    }
    this.refused.add(duty.key);
  }

  /**
   * The single most urgent thing any robot owes, or `null`.
   *
   * Ranked by *kind* across the whole table rather than by seat order: a shout that
   * cannot be applied must never keep the seat that owes the turn waiting, which is
   * how a table stops.
   */
  private nextDuty(): Duty | null {
    let best: Duty | null = null;
    for (const seat of this.options.controlled()) {
      const playerId = seat.playerId;
      const view = this.options.view(playerId);
      if (!view) {
        continue;
      }
      const version = view.table.version;
      const decision = this.decisionFor(playerId, view, version, seat.standIn);
      if (!decision.move) {
        continue;
      }
      const key = keyFor(playerId, version, decision.move);
      if (this.refusedAt === version && this.refused.has(key)) {
        continue;
      }
      const candidate = { playerId, move: decision.move, version, key, pause: decision.pause };
      if (!best || rankOf(candidate) < rankOf(best)) {
        best = candidate;
      }
    }
    return best;
  }

  /** This seat's decision for this exact table, taken once and remembered. */
  private decisionFor(
    playerId: PlayerId,
    view: BotView,
    version: number,
    standIn: boolean,
  ): { move: BotMove | null; pause: number } {
    const held = this.decided.get(playerId);
    if (held && held.version === version) {
      return held;
    }
    const move = chooseBotMove(view, () => this.options.random(playerId));
    const pause = move === null ? 0 : this.pauseFor(playerId, move, standIn, view);
    const decision = { version, move, pause };
    this.decided.set(playerId, decision);
    return decision;
  }

  private pauseFor(playerId: PlayerId, move: BotMove, standIn: boolean, view: BotView): number {
    const inSequence = move.inSequence === true;
    if (this.options.pauseMs) {
      return this.options.pauseMs(move.kind, inSequence);
    }
    if (move.kind === 'declare' && standIn) {
      /*
       * Exactly nought when the hand belongs to somebody else, rather than the very
       * short window a robot allows on its own last card: a covered seat's four-card
       * penalty would follow its owner into the standings for a rule they were not
       * there to keep, and no amount of jitter is worth risking that on.
       */
      return 0;
    }
    const spread = this.options.random(playerId);
    const between = (min: number, max: number): number => Math.round(min + spread * (max - min));
    switch (move.kind) {
      case 'breaker':
        return between(BOT_ANSWER_MIN_MS, BOT_ANSWER_MAX_MS);
      case 'declare':
        /*
         * The one pause that gets longer rather than shorter when the table is
         * leaning towards somebody: a robot nobody can catch is a rule a child never
         * gets to enforce. See `BOT_SOFT_DECLARE_MIN_MS`.
         */
        return anyAssisted(view.lenientToward)
          ? between(BOT_SOFT_DECLARE_MIN_MS, BOT_SOFT_DECLARE_MAX_MS)
          : between(BOT_DECLARE_MIN_MS, BOT_DECLARE_MAX_MS);
      case 'catch':
        return between(BOT_CATCH_MIN_MS, BOT_CATCH_MAX_MS);
      case 'turn':
        return inSequence
          ? between(BOT_SEQUENCE_MIN_MS, BOT_SEQUENCE_MAX_MS)
          : between(BOT_THINK_MIN_MS, BOT_THINK_MAX_MS);
    }
  }
}
