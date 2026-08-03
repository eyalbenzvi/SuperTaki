import type { Card, CardColor } from './cards.ts';
import { topCard } from './engine.ts';
import type { PlayContext } from './rules.ts';
import type { GamePhase, GameState, PlayerId, TakiModeState, TurnDirection } from './state.ts';

export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly name: string;
  readonly cardCount: number;
}

/**
 * Everything a non-host client is allowed to know about the table.
 * Contains no card identities other than the visible discard top, so hands can
 * never leak through a broadcast.
 */
export interface PublicGameState {
  readonly version: number;
  readonly phase: GamePhase;
  readonly players: readonly PublicPlayerView[];
  readonly drawPileCount: number;
  readonly discardTop: Card | null;
  readonly discardCount: number;
  readonly activeColor: CardColor;
  readonly direction: TurnDirection;
  readonly currentPlayerId: PlayerId | null;
  readonly takiMode: TakiModeState | null;
  readonly pendingPlus: boolean;
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
    phase: state.phase,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      cardCount: (state.hands[player.id] ?? []).length,
    })),
    drawPileCount: state.drawPile.length,
    discardTop: topCard(state),
    discardCount: state.discardPile.length,
    activeColor: state.activeColor,
    direction: state.direction,
    currentPlayerId: state.players[state.currentPlayerIndex]?.id ?? null,
    takiMode: state.takiMode,
    pendingPlus: state.pendingPlus,
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
  };
}

export interface StandingRow {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly cardCount: number;
  readonly rank: number;
}

/** Final standings: fewest remaining cards first, ties share a rank. */
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
