import type { Card, CardColor, CardId } from '../engine/cards.ts';
import type { GameEvent, PlayerId, TurnDirection } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';

/**
 * The shape of the table at one instant, reduced to what motion cares about.
 *
 * Not the whole public state: a signature is compared, and comparing a whole
 * snapshot would report a change every time a field nothing animates moved.
 * Everything here is either a position something can fly between or a value a
 * cue is keyed on.
 */
export interface TableSignature {
  readonly version: number;
  readonly discardTopId: CardId | null;
  readonly drawPileCount: number;
  readonly activeColor: CardColor;
  readonly direction: TurnDirection;
  readonly currentPlayerId: PlayerId | null;
  /** The local player's hand, in order, so a slot can be found by card id. */
  readonly handIds: readonly CardId[];
  /** Card count per seat, so a draw can be attributed to the seat that grew. */
  readonly counts: Readonly<Record<PlayerId, number>>;
}

/**
 * One accepted command, as the presentation layer needs to see it.
 *
 * The animation layer needs three facts in one place — what the table was, what
 * it is, and which events caused the difference — and until this existed no
 * consumer could see all three. The public state, the hand and the event batch
 * arrive as three separate store writes, in that order, so `from` is captured
 * when the first lands and the beat is published when the last does.
 *
 * There is deliberately no `origin` field. Telling "my move" from "somebody
 * else's" by matching the outstanding request id does not work: a `cardDrawn`
 * for me is emitted by moves that are not mine — a catch draws my penalty — and
 * the action lock can clear before the answer arrives. Where the distinction is
 * genuinely needed it comes from the event itself, and where it exists only to
 * stop a card being animated twice, the in-flight registry answers it directly.
 */
export interface Beat {
  /** Monotonic across the session's life, like the feed's ids. */
  readonly seq: number;
  readonly events: readonly GameEvent[];
  /** `null` for the first beat of a round, where there is no "before". */
  readonly from: TableSignature | null;
  readonly to: TableSignature;
}

/** Reduces a public state and the local hand to a comparable signature. */
export function tableSignature(publicState: PublicGameState, hand: readonly Card[]): TableSignature {
  const counts: Record<PlayerId, number> = {};
  for (const player of publicState.players) {
    counts[player.id] = player.cardCount;
  }
  return {
    version: publicState.version,
    discardTopId: publicState.discardTop?.id ?? null,
    drawPileCount: publicState.drawPileCount,
    activeColor: publicState.activeColor,
    direction: publicState.direction,
    currentPlayerId: publicState.currentPlayerId,
    handIds: hand.map((card) => card.id),
    counts,
  };
}
