import type { Card, CardColor, CardKind } from '../engine/cards.ts';
import { cardColor, isNumberCard, requiresColorChoice } from '../engine/cards.ts';
import { getPlayableCardIds } from '../engine/rules.ts';
import { computeStandings, playContextFromPublic, type StandingRow } from '../engine/views.ts';
import type { PublicGameState } from '../engine/views.ts';
import type { LobbyPlayer, LobbySnapshot } from '../network/protocol.ts';

/**
 * Derived view-model helpers. Pure functions of store state.
 *
 * Each takes the narrowest slice it actually reads rather than the whole store,
 * so a screen can subscribe to four fields instead of every field and still call
 * these directly. `AppState` satisfies all of them structurally.
 */

/** What every table-side helper below needs, and nothing more. */
export interface TableSnapshot {
  readonly publicState: PublicGameState | null;
  readonly localPlayerId: string | null;
  readonly hand: readonly Card[];
  readonly lobby: LobbySnapshot | null;
}

export function isHost(state: { readonly role: 'host' | 'client' | null }): boolean {
  return state.role === 'host';
}

export function localLobbyPlayer(state: Pick<TableSnapshot, 'lobby' | 'localPlayerId'>): LobbyPlayer | null {
  if (!state.lobby || !state.localPlayerId) {
    return null;
  }
  return state.lobby.players.find((player) => player.id === state.localPlayerId) ?? null;
}

export function seatedPlayers(state: Pick<TableSnapshot, 'lobby'>): readonly LobbyPlayer[] {
  return state.lobby?.players ?? [];
}

export function isMyTurn(state: Pick<TableSnapshot, 'publicState' | 'localPlayerId'>): boolean {
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
export function canBreakPlusThree(
  state: Pick<TableSnapshot, 'publicState' | 'localPlayerId' | 'hand'>,
): boolean {
  const plusThree = state.publicState?.plusThree;
  if (!plusThree || plusThree.playerId === state.localPlayerId) {
    return false;
  }
  return state.hand.some((card) => card.kind === 'breakPlusThree');
}

/** Ids of the cards the local player may legally play right now. */
export function playableCardIds(
  state: Pick<TableSnapshot, 'publicState' | 'localPlayerId' | 'hand'>,
): readonly string[] {
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

export function activeColor(state: Pick<TableSnapshot, 'publicState'>): CardColor | null {
  return state.publicState?.activeColor ?? null;
}

/* Hand order ---------------------------------------------------------------- */

const COLOR_RANK: Record<CardColor, number> = { red: 0, yellow: 1, green: 2, blue: 3 };

/** Within a colour: numbers first in value order, then the action cards. */
const KIND_RANK: Record<CardKind, number> = {
  number: 0,
  plus: 1,
  stop: 2,
  plusTwo: 3,
  direction: 4,
  taki: 5,
  superTaki: 6,
  colorChange: 7,
  king: 8,
  plusThree: 9,
  breakPlusThree: 10,
};

/**
 * The order the hand is shown in: grouped by colour, ordered inside each group,
 * colourless cards last.
 *
 * Purely a display concern — a card is always played by id — but it is the
 * difference between reading a hand of fourteen at a glance and hunting through
 * it. Deal order is meaningless to the player, and it made the hand reshuffle
 * itself visually every time a card was drawn.
 */
export function sortHandForDisplay(hand: readonly Card[]): readonly Card[] {
  return [...hand].sort((a, b) => {
    const colorA = cardColor(a);
    const colorB = cardColor(b);
    const rankA = colorA ? COLOR_RANK[colorA] : 4;
    const rankB = colorB ? COLOR_RANK[colorB] : 4;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
      return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    }
    const valueA = isNumberCard(a) ? a.value : 0;
    const valueB = isNumberCard(b) ? b.value : 0;
    return valueA - valueB;
  });
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
export function opponents(state: TableSnapshot): readonly OpponentView[] {
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

export function currentPlayerName(state: Pick<TableSnapshot, 'publicState'>): string | null {
  const { publicState } = state;
  if (!publicState?.currentPlayerId) {
    return null;
  }
  return publicState.players.find((player) => player.id === publicState.currentPlayerId)?.name ?? null;
}

export function playerName(state: Pick<TableSnapshot, 'publicState' | 'lobby'>, playerId: string): string {
  const fromState = state.publicState?.players.find((player) => player.id === playerId)?.name;
  if (fromState) {
    return fromState;
  }
  return state.lobby?.players.find((player) => player.id === playerId)?.name ?? playerId;
}

export function standings(state: Pick<TableSnapshot, 'publicState'>): readonly StandingRow[] {
  return state.publicState ? computeStandings(state.publicState) : [];
}

export function winnerName(state: Pick<TableSnapshot, 'publicState' | 'lobby'>): string | null {
  const winnerId = state.publicState?.winnerId;
  return winnerId ? playerName(state, winnerId) : null;
}

export function isTakiOpenForMe(state: Pick<TableSnapshot, 'publicState' | 'localPlayerId'>): boolean {
  const taki = state.publicState?.takiMode;
  return taki !== null && taki !== undefined && taki.playerId === state.localPlayerId;
}

export function connectedCount(state: Pick<TableSnapshot, 'lobby'>): number {
  return seatedPlayers(state).filter((player) => player.health !== 'disconnected').length;
}

export function everyoneConnected(state: Pick<TableSnapshot, 'lobby'>): boolean {
  return seatedPlayers(state).every((player) => player.health === 'connected');
}
