import type { Card, CardColor } from '../engine/cards.ts';
import { requiresColorChoice } from '../engine/cards.ts';
import { getPlayableCardIds } from '../engine/rules.ts';
import { computeStandings, playContextFromPublic, type StandingRow } from '../engine/views.ts';
import type { LobbyPlayer } from '../network/protocol.ts';
import type { AppState } from './store.ts';

/** Derived view-model helpers. Pure functions of store state. */

export function isHost(state: AppState): boolean {
  return state.role === 'host';
}

export function localLobbyPlayer(state: AppState): LobbyPlayer | null {
  if (!state.lobby || !state.localPlayerId) {
    return null;
  }
  return state.lobby.players.find((player) => player.id === state.localPlayerId) ?? null;
}

export function seatedPlayers(state: AppState): readonly LobbyPlayer[] {
  return state.lobby?.players ?? [];
}

export function isMyTurn(state: AppState): boolean {
  const { publicState, localPlayerId } = state;
  return (
    publicState !== null &&
    publicState.phase === 'playing' &&
    localPlayerId !== null &&
    publicState.currentPlayerId === localPlayerId
  );
}

/**
 * Whether the local player holds a +3 Breaker while a +3 is waiting to be
 * answered. Worked out from the player's own hand, because who holds a breaker
 * is deliberately never published to the table.
 */
export function canBreakPlusThree(state: AppState): boolean {
  const plusThree = state.publicState?.plusThree;
  if (!plusThree || plusThree.playerId === state.localPlayerId) {
    return false;
  }
  return state.hand.some((card) => card.kind === 'breakPlusThree');
}

/** Ids of the cards the local player may legally play right now. */
export function playableCardIds(state: AppState): readonly string[] {
  if (!state.publicState) {
    return [];
  }
  // An open +3 suspends the turn order: the only legal card at the table is a
  // breaker, from whoever holds one.
  if (state.publicState.plusThree) {
    return canBreakPlusThree(state)
      ? state.hand.filter((card) => card.kind === 'breakPlusThree').map((card) => card.id)
      : [];
  }
  if (!isMyTurn(state)) {
    return [];
  }
  return getPlayableCardIds(state.hand, playContextFromPublic(state.publicState));
}

export function needsColorChoice(card: Card): boolean {
  return requiresColorChoice(card);
}

export function activeColor(state: AppState): CardColor | null {
  return state.publicState?.activeColor ?? null;
}

export interface OpponentView {
  readonly id: string;
  readonly name: string;
  readonly cardCount: number;
  readonly isCurrent: boolean;
  readonly health: LobbyPlayer['health'];
  readonly isHost: boolean;
}

/**
 * Opponents in play order starting after the local player, so the seating on
 * screen matches the order of play regardless of who is looking.
 */
export function opponents(state: AppState): readonly OpponentView[] {
  const { publicState, localPlayerId, lobby } = state;
  if (!publicState) {
    return [];
  }
  const players = publicState.players;
  const localIndex = players.findIndex((player) => player.id === localPlayerId);
  // A viewer who holds no seat (nothing dealt yet, or a stale identity) sees the
  // whole table in seat order rather than a truncated list.
  const ordered =
    localIndex >= 0 ? [...players.slice(localIndex + 1), ...players.slice(0, localIndex)] : [...players];

  return ordered
    .filter((player) => player.id !== localPlayerId)
    .map((player) => {
      const lobbyPlayer = lobby?.players.find((candidate) => candidate.id === player.id);
      return {
        id: player.id,
        name: player.name,
        cardCount: player.cardCount,
        isCurrent: publicState.currentPlayerId === player.id,
        health: lobbyPlayer?.health ?? 'connected',
        isHost: lobbyPlayer?.isHost ?? false,
      };
    });
}

export function currentPlayerName(state: AppState): string | null {
  const { publicState } = state;
  if (!publicState?.currentPlayerId) {
    return null;
  }
  return publicState.players.find((player) => player.id === publicState.currentPlayerId)?.name ?? null;
}

export function playerName(state: AppState, playerId: string): string {
  const fromState = state.publicState?.players.find((player) => player.id === playerId)?.name;
  if (fromState) {
    return fromState;
  }
  return state.lobby?.players.find((player) => player.id === playerId)?.name ?? playerId;
}

export function standings(state: AppState): readonly StandingRow[] {
  return state.publicState ? computeStandings(state.publicState) : [];
}

export function winnerName(state: AppState): string | null {
  const winnerId = state.publicState?.winnerId;
  return winnerId ? playerName(state, winnerId) : null;
}

export function isTakiOpenForMe(state: AppState): boolean {
  const taki = state.publicState?.takiMode;
  return taki !== null && taki !== undefined && taki.playerId === state.localPlayerId;
}

export function connectedCount(state: AppState): number {
  return seatedPlayers(state).filter((player) => player.health !== 'disconnected').length;
}

export function everyoneConnected(state: AppState): boolean {
  return seatedPlayers(state).every((player) => player.health === 'connected');
}
