import type { Card, CardColor } from './cards.ts';
import { topCard } from './engine.ts';
import type { PlayContext } from './rules.ts';
import type {
  GameEndReason,
  GameMode,
  GamePhase,
  GameState,
  PlayerId,
  TakiModeState,
  TurnDirection,
} from './state.ts';

export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly name: string;
  readonly cardCount: number;
  /** True for a seat that has left the round. Their cards are frozen out of play. */
  readonly left?: boolean;
  /**
   * How many hands this player has emptied, in a "stairs" round.
   *
   * Public because it is the score of that round: how far down the staircase
   * everybody is, is exactly what a card count is in a classic one. Sent only for a
   * stairs round, and absent — rather than nought — in a classic one, so no screen
   * can draw a staircase for a table that is not playing one.
   */
  readonly stairsStep?: number;
}

/**
 * Everything a non-host client is allowed to know about the table.
 * Contains no card identities other than the visible discard top, so hands can
 * never leak through a broadcast.
 */
export interface PublicGameState {
  readonly version: number;
  /** Turn counter, so a client can tell whether its intent is still current. */
  readonly turnSeq?: number;
  readonly phase: GamePhase;
  readonly endReason?: GameEndReason;
  /**
   * How this round is won. Optional so a snapshot from a peer that predates the
   * modes still reads, and absent is `classic` — the game as it was.
   */
  readonly mode?: GameMode;
  readonly players: readonly PublicPlayerView[];
  readonly drawPileCount: number;
  readonly discardTop: Card | null;
  readonly discardCount: number;
  readonly activeColor: CardColor;
  readonly direction: TurnDirection;
  readonly currentPlayerId: PlayerId | null;
  readonly takiMode: TakiModeState | null;
  readonly pendingPlus: boolean;
  readonly pendingDraw: number;
  readonly freePlay: boolean;
  /**
   * Set while a +3 waits to be answered. Only the player who played it is
   * named: who holds a breaker stays private, and a client already knows
   * whether it can answer by looking at its own hand.
   */
  readonly plusThree: { readonly playerId: PlayerId } | null;
  /**
   * Who has declared "last card". Public on purpose: at a real table the
   * declaration is a shout everybody hears, and it is what tells the others
   * whether the player on one card is safe or exposed.
   */
  readonly declaredLastCard: readonly PlayerId[];
  readonly winnerId: PlayerId | null;
}

/** A single player's private hand, sent only to that player. */
export interface PrivateHandView {
  readonly version: number;
  readonly playerId: PlayerId;
  readonly cards: readonly Card[];
}

export function toPublicGameState(state: GameState): PublicGameState {
  return {
    version: state.version,
    turnSeq: state.turnSeq,
    phase: state.phase,
    ...(state.endReason ? { endReason: state.endReason } : {}),
    mode: state.mode,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      cardCount: (state.hands[player.id] ?? []).length,
      ...(player.left === true ? { left: true } : {}),
      ...(state.mode === 'stairs' ? { stairsStep: state.stairs[player.id] ?? 0 } : {}),
    })),
    drawPileCount: state.drawPile.length,
    discardTop: topCard(state),
    discardCount: state.discardPile.length,
    activeColor: state.activeColor,
    direction: state.direction,
    currentPlayerId: state.players[state.currentPlayerIndex]?.id ?? null,
    takiMode: state.takiMode,
    pendingPlus: state.pendingPlus,
    pendingDraw: state.pendingDraw,
    freePlay: state.freePlay,
    plusThree: state.plusThree ? { playerId: state.plusThree.playerId } : null,
    declaredLastCard: state.declaredLastCard.slice(),
    winnerId: state.winnerId,
  };
}

export function toPrivateHandView(state: GameState, playerId: PlayerId): PrivateHandView {
  return {
    version: state.version,
    playerId,
    cards: (state.hands[playerId] ?? []).slice(),
  };
}

/** Rule context derived from public state — identical semantics on host and client. */
export function playContextFromPublic(state: PublicGameState): PlayContext {
  return {
    activeColor: state.activeColor,
    topCard: state.discardTop,
    openTakiColor: state.takiMode?.color ?? null,
    takiSwitchOpen: state.takiMode?.takisOnly ?? false,
    pendingDraw: state.pendingDraw,
    freePlay: state.freePlay,
  };
}

export interface StandingRow {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly cardCount: number;
  readonly rank: number;
  /** Hands emptied out of the eight the staircase has, in a stairs round only. */
  readonly stairsStep?: number;
}

/**
 * Final standings: fewest remaining cards first, ties share a rank.
 *
 * A player who left is still listed, with the hand they were holding when they
 * went. Dropping them would erase somebody from the standings of a round they may
 * have been winning, which is not an honest result.
 *
 * In a stairs round the staircase outranks the hand, because it has to: a player
 * one step from the end is holding two cards and a player who has emptied nothing
 * may be holding one, and ordering those by hand size would put the loser on top.
 * The hand is still the tie-break within a step — of two players on the same step,
 * the one closer to finishing it is ahead — and a tie needs both to match, so two
 * players share a place only when they are genuinely level.
 */
export function computeStandings(state: PublicGameState): StandingRow[] {
  const stairs = state.mode === 'stairs';
  const stepOf = (player: PublicPlayerView): number => player.stairsStep ?? 0;
  const sorted = state.players
    .map((player) => ({ ...player }))
    .sort(
      (a, b) =>
        (stairs ? stepOf(b) - stepOf(a) : 0) || a.cardCount - b.cardCount || a.name.localeCompare(b.name),
    );

  const rows: StandingRow[] = [];
  let previous: { readonly step: number; readonly cardCount: number } | null = null;
  let rank = 0;
  sorted.forEach((player, index) => {
    if (previous === null || player.cardCount !== previous.cardCount || stepOf(player) !== previous.step) {
      rank = index + 1;
      previous = { step: stepOf(player), cardCount: player.cardCount };
    }
    rows.push({
      playerId: player.id,
      name: player.name,
      cardCount: player.cardCount,
      rank,
      ...(stairs ? { stairsStep: stepOf(player) } : {}),
    });
  });
  return rows;
}
