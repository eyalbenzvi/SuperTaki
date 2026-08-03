import {
  CARDS_DEALT_PER_PLAYER,
  buildDeck,
  isCardColor,
  isNumberCard,
  isWildCard,
  type Card,
  type CardColor,
} from './cards.ts';
import { createRng, shuffle, type RngState } from './prng.ts';
import { hasPlayableCard, isCardPlayable, stepIndex, type PlayContext } from './rules.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type CommandResult,
  type EnginePlayer,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RejectionCode,
  type TurnDirection,
} from './state.ts';

function reject(code: RejectionCode): CommandResult {
  return { ok: false, rejection: { code } };
}

/** Mutable working copy used while a single command is resolved. */
interface Draft {
  version: number;
  phase: GameState['phase'];
  players: readonly EnginePlayer[];
  hands: Record<PlayerId, Card[]>;
  drawPile: Card[];
  discardPile: Card[];
  activeColor: CardColor;
  direction: TurnDirection;
  currentPlayerIndex: number;
  takiMode: GameState['takiMode'];
  pendingPlus: boolean;
  rng: RngState;
  winnerId: PlayerId | null;
  seed: number;
}

function toDraft(state: GameState): Draft {
  const hands: Record<PlayerId, Card[]> = {};
  for (const player of state.players) {
    hands[player.id] = (state.hands[player.id] ?? []).slice();
  }
  return {
    version: state.version,
    phase: state.phase,
    players: state.players,
    hands,
    drawPile: state.drawPile.slice(),
    discardPile: state.discardPile.slice(),
    activeColor: state.activeColor,
    direction: state.direction,
    currentPlayerIndex: state.currentPlayerIndex,
    takiMode: state.takiMode,
    pendingPlus: state.pendingPlus,
    rng: state.rng,
    winnerId: state.winnerId,
    seed: state.seed,
  };
}

function freeze(draft: Draft): GameState {
  return {
    version: draft.version,
    phase: draft.phase,
    players: draft.players,
    hands: draft.hands,
    drawPile: draft.drawPile,
    discardPile: draft.discardPile,
    activeColor: draft.activeColor,
    direction: draft.direction,
    currentPlayerIndex: draft.currentPlayerIndex,
    takiMode: draft.takiMode,
    pendingPlus: draft.pendingPlus,
    rng: draft.rng,
    winnerId: draft.winnerId,
    seed: draft.seed,
  };
}

export function topCard(state: Pick<GameState, 'discardPile'>): Card | null {
  return state.discardPile.length > 0 ? (state.discardPile[state.discardPile.length - 1] as Card) : null;
}

export function currentPlayer(state: GameState): EnginePlayer | null {
  return state.players[state.currentPlayerIndex] ?? null;
}

/** Builds the {@link PlayContext} for the supplied authoritative state. */
export function playContextFromState(state: GameState): PlayContext {
  return {
    activeColor: state.activeColor,
    topCard: topCard(state),
    openTakiColor: state.takiMode?.color ?? null,
  };
}

/**
 * Creates a fresh game.
 *
 * The opening card is the first *number* card drawn from the shuffled deck;
 * any action/wild card met on the way is moved to the bottom of the draw pile.
 * This keeps the first turn unambiguous without discarding cards.
 */
export function createGame(players: readonly EnginePlayer[], seed: number): CommandResult {
  if (players.length < MIN_PLAYERS) {
    return reject('notEnoughPlayers');
  }
  if (players.length > MAX_PLAYERS) {
    return reject('tooManyPlayers');
  }
  const uniqueIds = new Set(players.map((player) => player.id));
  if (uniqueIds.size !== players.length) {
    return reject('duplicatePlayerId');
  }

  const shuffled = shuffle(buildDeck(), createRng(seed));
  const rng = shuffled.state;
  const pile = shuffled.items;

  const hands: Record<PlayerId, Card[]> = {};
  for (const player of players) {
    hands[player.id] = [];
  }
  for (let round = 0; round < CARDS_DEALT_PER_PLAYER; round += 1) {
    for (const player of players) {
      const card = pile.shift();
      if (card) {
        (hands[player.id] as Card[]).push(card);
      }
    }
  }

  const buried: Card[] = [];
  let opening: Card | null = null;
  while (pile.length > 0) {
    const card = pile.shift() as Card;
    if (isNumberCard(card)) {
      opening = card;
      break;
    }
    buried.push(card);
  }
  if (!opening) {
    // Impossible with the documented deck, but keep the engine total.
    return reject('notEnoughPlayers');
  }

  const drawPile = pile.concat(buried);
  const state: GameState = {
    version: 1,
    phase: 'playing',
    players,
    hands,
    drawPile,
    discardPile: [opening],
    activeColor: opening.color,
    direction: 1,
    currentPlayerIndex: 0,
    takiMode: null,
    pendingPlus: false,
    rng,
    winnerId: null,
    seed,
  };

  const firstPlayer = players[0] as EnginePlayer;
  const events: GameEvent[] = [
    { type: 'gameStarted', firstPlayerId: firstPlayer.id, activeColor: opening.color },
    { type: 'turnChanged', playerId: firstPlayer.id },
  ];
  return { ok: true, state, events };
}

function advanceTurn(draft: Draft, events: GameEvent[]): void {
  draft.currentPlayerIndex = stepIndex(draft.currentPlayerIndex, draft.direction, draft.players.length);
  const next = draft.players[draft.currentPlayerIndex] as EnginePlayer;
  events.push({ type: 'turnChanged', playerId: next.id });
}

/** Refills the draw pile from the discard pile, keeping the visible top card. */
function recycleDrawPile(draft: Draft, events: GameEvent[]): void {
  if (draft.drawPile.length > 0 || draft.discardPile.length <= 1) {
    return;
  }
  const keep = draft.discardPile[draft.discardPile.length - 1] as Card;
  const recyclable = draft.discardPile.slice(0, -1);
  const shuffled = shuffle(recyclable, draft.rng);
  draft.rng = shuffled.state;
  draft.drawPile = shuffled.items;
  draft.discardPile = [keep];
  events.push({ type: 'drawPileRecycled', count: shuffled.items.length });
}

/** Draws `count` cards, recycling when needed. Returns how many were actually drawn. */
function drawCards(draft: Draft, playerId: PlayerId, count: number, events: GameEvent[]): number {
  let drawn = 0;
  for (let i = 0; i < count; i += 1) {
    if (draft.drawPile.length === 0) {
      recycleDrawPile(draft, events);
    }
    const card = draft.drawPile.shift();
    if (!card) {
      events.push({ type: 'drawPileExhausted' });
      break;
    }
    (draft.hands[playerId] as Card[]).push(card);
    drawn += 1;
  }
  if (drawn > 0) {
    events.push({ type: 'cardDrawn', playerId, count: drawn });
  }
  return drawn;
}

/**
 * Applies the effect of the card that ended a player's action.
 * Called for a card played outside Taki mode, and for the final card of a
 * closed Taki sequence.
 */
function resolveCardEffect(draft: Draft, card: Card, events: GameEvent[]): void {
  switch (card.kind) {
    case 'stop': {
      const skippedIndex = stepIndex(draft.currentPlayerIndex, draft.direction, draft.players.length);
      const skipped = draft.players[skippedIndex] as EnginePlayer;
      events.push({ type: 'playerSkipped', playerId: skipped.id });
      draft.currentPlayerIndex = skippedIndex;
      advanceTurn(draft, events);
      return;
    }
    case 'plus': {
      const player = draft.players[draft.currentPlayerIndex] as EnginePlayer;
      draft.pendingPlus = true;
      events.push({ type: 'extraTurn', playerId: player.id });
      return;
    }
    case 'direction': {
      draft.direction = draft.direction === 1 ? -1 : 1;
      events.push({ type: 'directionChanged', direction: draft.direction });
      advanceTurn(draft, events);
      return;
    }
    case 'number':
    case 'taki':
    case 'superTaki':
    case 'colorChange': {
      advanceTurn(draft, events);
      return;
    }
  }
}

function applyPlayCard(
  state: GameState,
  playerId: PlayerId,
  cardId: string,
  chosenColor: CardColor | undefined,
): CommandResult {
  const hand = state.hands[playerId] ?? [];
  const card = hand.find((candidate) => candidate.id === cardId);
  if (!card) {
    return reject('cardNotInHand');
  }

  const wild = isWildCard(card);
  if (wild) {
    if (chosenColor === undefined) {
      return reject('colorRequired');
    }
    if (!isCardColor(chosenColor)) {
      return reject('colorNotAllowed');
    }
  } else if (chosenColor !== undefined) {
    return reject('colorNotAllowed');
  }

  if (state.takiMode) {
    if (wild) {
      return reject('wildNotAllowedInTaki');
    }
    if (card.color !== state.takiMode.color) {
      return reject('wrongTakiColor');
    }
  } else if (!isCardPlayable(card, playContextFromState(state))) {
    return reject('illegalCard');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];

  draft.hands[playerId] = (draft.hands[playerId] as Card[]).filter((candidate) => candidate.id !== cardId);
  draft.discardPile.push(card);

  const resultingColor = wild ? (chosenColor as CardColor) : card.color;
  draft.activeColor = resultingColor;
  draft.pendingPlus = false;
  events.push({ type: 'cardPlayed', playerId, card, resultingColor });
  if (wild) {
    events.push({ type: 'colorChosen', playerId, color: resultingColor });
  }

  if ((draft.hands[playerId] ?? []).length === 0) {
    draft.phase = 'finished';
    draft.winnerId = playerId;
    draft.takiMode = null;
    draft.pendingPlus = false;
    events.push({ type: 'playerWon', playerId });
    draft.version += 1;
    return { ok: true, state: freeze(draft), events };
  }

  if (draft.takiMode) {
    // Inside a sequence: accumulate; effects are resolved when the Taki closes.
    draft.takiMode = { ...draft.takiMode, cardsPlayed: draft.takiMode.cardsPlayed + 1 };
  } else if (card.kind === 'taki' || card.kind === 'superTaki') {
    draft.takiMode = {
      color: resultingColor,
      playerId,
      cardsPlayed: 1,
      openedWithSuperTaki: card.kind === 'superTaki',
    };
    events.push({
      type: 'takiOpened',
      playerId,
      color: resultingColor,
      superTaki: card.kind === 'superTaki',
    });
  } else {
    resolveCardEffect(draft, card, events);
  }

  draft.version += 1;
  return { ok: true, state: freeze(draft), events };
}

function applyCloseTaki(state: GameState, playerId: PlayerId): CommandResult {
  if (!state.takiMode || state.takiMode.playerId !== playerId) {
    return reject('noTakiOpen');
  }
  const draft = toDraft(state);
  const events: GameEvent[] = [];
  const cardsPlayed = state.takiMode.cardsPlayed;
  draft.takiMode = null;
  events.push({ type: 'takiClosed', playerId, cardsPlayed });

  const last = topCard(state);
  if (last) {
    resolveCardEffect(draft, last, events);
  } else {
    advanceTurn(draft, events);
  }

  draft.version += 1;
  return { ok: true, state: freeze(draft), events };
}

function applyDrawCard(state: GameState, playerId: PlayerId): CommandResult {
  if (state.takiMode) {
    return reject('cannotDrawDuringTaki');
  }
  if (state.pendingPlus && hasPlayableCard(state.hands[playerId] ?? [], playContextFromState(state))) {
    return reject('mustPlayAfterPlus');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];
  drawCards(draft, playerId, 1, events);
  draft.pendingPlus = false;
  advanceTurn(draft, events);
  draft.version += 1;
  return { ok: true, state: freeze(draft), events };
}

/**
 * Single entry point for every state transition.
 * Pure: returns either a new state plus emitted events, or a rejection code.
 */
export function applyCommand(state: GameState, command: GameCommand): CommandResult {
  if (state.phase !== 'playing') {
    return reject('gameFinished');
  }
  const actor = state.players.find((player) => player.id === command.playerId);
  if (!actor) {
    return reject('unknownPlayer');
  }
  if (currentPlayer(state)?.id !== command.playerId) {
    return reject('notYourTurn');
  }

  switch (command.type) {
    case 'playCard':
      return applyPlayCard(state, command.playerId, command.cardId, command.chosenColor);
    case 'closeTaki':
      return applyCloseTaki(state, command.playerId);
    case 'drawCard':
      return applyDrawCard(state, command.playerId);
  }
}
