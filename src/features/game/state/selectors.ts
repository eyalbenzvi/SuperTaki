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

/** Whether `playerId` has declared "last card" for the card they hold now. */
export function hasDeclaredLastCard(state: Pick<TableSnapshot, 'publicState'>, playerId: string): boolean {
  return state.publicState?.declaredLastCard.includes(playerId) ?? false;
}

/**
 * Whether the local player owes a "last card" declaration.
 *
 * True from the moment their hand comes down to one card until they declare.
 * Deliberately not conditioned on the turn: the declaration is legal at any
 * moment, and the whole point of showing it early is that a player is never
 * caught out on somebody else's turn.
 */
export function mustDeclareLastCard(
  state: Pick<TableSnapshot, 'publicState' | 'localPlayerId' | 'hand'>,
): boolean {
  const { publicState, localPlayerId } = state;
  if (!publicState || publicState.phase !== 'playing' || !localPlayerId) {
    return false;
  }
  return state.hand.length === 1 && !publicState.declaredLastCard.includes(localPlayerId);
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
  /** Has declared "last card" for the single card they are holding. */
  readonly declaredLastCard: boolean;
  /** Has left the round; their cards are frozen out of play. */
  readonly left: boolean;
  /** On one card and still silent, so this seat can be called out. */
  readonly catchable: boolean;
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
        declaredLastCard: publicState.declaredLastCard.includes(player.id),
        left: player.left === true,
        catchable:
          publicState.phase === 'playing' &&
          player.cardCount === 1 &&
          !publicState.declaredLastCard.includes(player.id) &&
          player.left !== true &&
          /*
           * Somebody who is not there cannot shout, so calling them out for
           * silence is not a catch, it is farming — four cards an orbit off a
           * player whose phone is rebooting. The host refuses it too; this only
           * keeps the button from appearing.
           */
          (lobbyPlayer?.health ?? 'connected') === 'connected',
      };
    });
}

/** The seat the table is waiting for, and why, straight from the host. */
export function waitingFor(
  state: Pick<TableSnapshot, 'lobby'>,
): { readonly playerId: string; readonly reason: NonNullable<LobbySnapshot['waitingReason']> } | null {
  const lobby = state.lobby;
  if (!lobby?.waitingFor || !lobby.waitingReason) {
    return null;
  }
  return { playerId: lobby.waitingFor, reason: lobby.waitingReason };
}

/** Seats currently away, with how long the host has been holding them. */
export function absentPlayers(
  state: Pick<TableSnapshot, 'lobby'>,
): readonly { readonly id: string; readonly name: string; readonly absentSince: number }[] {
  const lobby = state.lobby;
  if (!lobby) {
    return [];
  }
  return lobby.players
    .filter((player) => player.absentSince !== undefined && player.left !== true)
    .map((player) => ({
      id: player.id,
      name: player.name,
      absentSince: player.absentSince as number,
    }));
}

/**
 * How much longer a seat will be held, in local milliseconds.
 *
 * The host sends when the seat went quiet *on its own clock*, together with the
 * clock reading at which the snapshot was built, so the offset between the two
 * devices can be cancelled out once here rather than accumulating into a countdown
 * that drifts visibly against the host's.
 */
export function seatHoldRemainingMs(
  state: Pick<TableSnapshot, 'lobby'>,
  absentSince: number,
  now: number = Date.now(),
): number {
  const lobby = state.lobby;
  const graceMs = lobby?.seatGraceMs ?? 0;
  const offset = lobby?.sentAt !== undefined ? now - lobby.sentAt : 0;
  const elapsed = now - (absentSince + offset);
  return Math.max(graceMs - elapsed, 0);
}

export function isPaused(state: { readonly pausedBy: string | null }): boolean {
  return state.pausedBy !== null;
}

/** Whether the round ended without a winner. */
export function wasAbandoned(state: Pick<TableSnapshot, 'publicState'>): boolean {
  return state.publicState?.endReason === 'abandoned';
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
