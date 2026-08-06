import type { Card, CardColor } from './cards.ts';
import { topCard } from './engine.ts';
import type { PlayContext } from './rules.ts';
import type { GameEndReason, GamePhase, GameState, PlayerId, TakiModeState, TurnDirection } from './state.ts';

export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly name: string;
  readonly cardCount: number;
  /** True for a seat that has left the round. Their cards are frozen out of play. */
  readonly left?: boolean;
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
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      cardCount: (state.hands[player.id] ?? []).length,
      ...(player.left === true ? { left: true } : {}),
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
}

/**
 * Final standings: fewest remaining cards first, ties share a rank.
 *
 * A player who left is still listed, with the hand they were holding when they
 * went. Dropping them would erase somebody from the standings of a round they may
 * have been winning, which is not an honest result.
 */
export function computeStandings(state: PublicGameState): StandingRow[] {
  const sorted = state.players
    .map((player) => ({ ...player }))
    .sort((a, b) => a.cardCount - b.cardCount || a.name.localeCompare(b.name));

  const rows: StandingRow[] = [];
  let previousCount: number | null = null;
  let rank = 0;
  sorted.forEach((player, index) => {
    if (previousCount === null || player.cardCount !== previousCount) {
      rank = index + 1;
      previousCount = player.cardCount;
    }
    rows.push({ playerId: player.id, name: player.name, cardCount: player.cardCount, rank });
  });
  return rows;
}
