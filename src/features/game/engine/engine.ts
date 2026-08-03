import {
  CARDS_DEALT_PER_PLAYER,
  PLUS_THREE_PENALTY,
  PLUS_TWO_PENALTY,
  buildDeck,
  cardColor,
  isCardColor,
  isNumberCard,
  isWildCard,
  requiresColorChoice,
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
  pendingDraw: number;
  freePlay: boolean;
  plusThree: GameState['plusThree'];
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
    pendingDraw: state.pendingDraw,
    freePlay: state.freePlay,
    plusThree: state.plusThree,
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
    pendingDraw: draft.pendingDraw,
    freePlay: draft.freePlay,
    plusThree: draft.plusThree,
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
    pendingDraw: state.pendingDraw,
    freePlay: state.freePlay,
  };
}

/**
 * Creates a fresh game.
 *
 * The opening card is the first *number* card drawn from the shuffled deck;
 * any action/wild card met on the way is moved to the bottom of the draw pile.
 * This keeps the first turn unambiguous without discarding cards.
 *
 * `initialVersion` lets a second round continue the version sequence of the
 * first. Clients drop snapshots older than the newest one they applied, so a
 * new round must never restart numbering.
 */
export function createGame(
  players: readonly EnginePlayer[],
  seed: number,
  initialVersion = 1,
): CommandResult {
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
    version: initialVersion,
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
    pendingDraw: 0,
    freePlay: false,
    plusThree: null,
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
 * Settles an open +3: either the breaker sends it back at whoever played it,
 * or everybody else pays. Either way the turn then moves on from the +3
 * player's seat, which is still the seat to move.
 */
function resolvePlusThree(draft: Draft, breakerId: PlayerId | null, events: GameEvent[]): void {
  const sourceId = draft.plusThree?.playerId ?? (draft.players[draft.currentPlayerIndex] as EnginePlayer).id;
  draft.plusThree = null;

  if (breakerId !== null) {
    events.push({ type: 'plusThreeBroken', playerId: breakerId, targetId: sourceId });
    drawCards(draft, sourceId, PLUS_THREE_PENALTY, events);
  } else {
    for (const player of draft.players) {
      if (player.id !== sourceId) {
        drawCards(draft, player.id, PLUS_THREE_PENALTY, events);
      }
    }
  }
  advanceTurn(draft, events);
}

/**
 * Opens the window in which a +3 Breaker may be played out of turn. Only
 * players actually holding a breaker are waited for, so the common case — no
 * breaker at the table — settles straight away and nobody is asked anything.
 */
function openPlusThree(draft: Draft, events: GameEvent[]): void {
  const playerId = (draft.players[draft.currentPlayerIndex] as EnginePlayer).id;
  events.push({ type: 'plusThreePlayed', playerId });

  const awaiting = draft.players
    .filter(
      (player) =>
        player.id !== playerId &&
        (draft.hands[player.id] ?? []).some((card) => card.kind === 'breakPlusThree'),
    )
    .map((player) => player.id);

  if (awaiting.length === 0) {
    resolvePlusThree(draft, null, events);
    return;
  }
  draft.plusThree = { playerId, awaiting };
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
    case 'plusTwo': {
      const player = draft.players[draft.currentPlayerIndex] as EnginePlayer;
      draft.pendingDraw += PLUS_TWO_PENALTY;
      events.push({ type: 'drawStacked', playerId: player.id, total: draft.pendingDraw });
      advanceTurn(draft, events);
      return;
    }
    case 'direction': {
      draft.direction = draft.direction === 1 ? -1 : 1;
      events.push({ type: 'directionChanged', direction: draft.direction });
      advanceTurn(draft, events);
      return;
    }
    case 'king': {
      // The King answers anything: it wipes a pending +2 run and any leftover
      // obligation, then hands the same player a turn with no restrictions.
      const player = draft.players[draft.currentPlayerIndex] as EnginePlayer;
      draft.pendingDraw = 0;
      draft.pendingPlus = true;
      draft.freePlay = true;
      events.push({ type: 'effectsCancelled', playerId: player.id });
      events.push({ type: 'extraTurn', playerId: player.id });
      return;
    }
    case 'plusThree': {
      openPlusThree(draft, events);
      return;
    }
    case 'number':
    case 'taki':
    case 'superTaki':
    case 'colorChange':
    case 'breakPlusThree': {
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

  // A +3 Breaker is only ever an answer to an open +3, and while a +3 is open
  // nothing else may be played — not even by the player whose turn it is.
  const answeringPlusThree = state.plusThree !== null && card.kind === 'breakPlusThree';
  if (state.plusThree !== null) {
    if (!answeringPlusThree || !state.plusThree.awaiting.includes(playerId)) {
      return reject('awaitingBreak');
    }
  } else if (card.kind === 'breakPlusThree') {
    return reject('noPlusThreeOpen');
  }

  if (requiresColorChoice(card)) {
    if (chosenColor === undefined) {
      return reject('colorRequired');
    }
    if (!isCardColor(chosenColor)) {
      return reject('colorNotAllowed');
    }
  } else if (chosenColor !== undefined) {
    return reject('colorNotAllowed');
  }

  if (!answeringPlusThree) {
    if (state.takiMode) {
      if (isWildCard(card)) {
        return reject('wildNotAllowedInTaki');
      }
      if (card.color !== state.takiMode.color) {
        return reject('wrongTakiColor');
      }
    } else if (state.pendingDraw > 0 && card.kind !== 'plusTwo' && card.kind !== 'king') {
      return reject('mustAnswerDraw');
    } else if (!isCardPlayable(card, playContextFromState(state))) {
      return reject('illegalCard');
    }
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];

  draft.hands[playerId] = (draft.hands[playerId] as Card[]).filter((candidate) => candidate.id !== cardId);
  draft.discardPile.push(card);

  // Only Change Colour repaints the table; every other colourless card leaves
  // the leading colour exactly as it was.
  const resultingColor = chosenColor ?? cardColor(card) ?? draft.activeColor;
  draft.activeColor = resultingColor;
  draft.pendingPlus = false;
  draft.freePlay = false;
  events.push({ type: 'cardPlayed', playerId, card, resultingColor });
  if (chosenColor !== undefined) {
    events.push({ type: 'colorChosen', playerId, color: resultingColor });
  }

  if ((draft.hands[playerId] ?? []).length === 0) {
    draft.phase = 'finished';
    draft.winnerId = playerId;
    draft.takiMode = null;
    draft.pendingPlus = false;
    draft.pendingDraw = 0;
    draft.plusThree = null;
    events.push({ type: 'playerWon', playerId });
    draft.version += 1;
    return { ok: true, state: freeze(draft), events };
  }

  if (answeringPlusThree) {
    resolvePlusThree(draft, playerId, events);
  } else if (draft.takiMode) {
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

/** Declines to answer an open +3; the last decline settles it. */
function applyPassBreak(state: GameState, playerId: PlayerId): CommandResult {
  const pending = state.plusThree;
  if (!pending || !pending.awaiting.includes(playerId)) {
    return reject('noPlusThreeOpen');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];
  const awaiting = pending.awaiting.filter((candidate) => candidate !== playerId);
  if (awaiting.length === 0) {
    resolvePlusThree(draft, null, events);
  } else {
    draft.plusThree = { ...pending, awaiting };
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
  // A pending +2 run must be paid in full; otherwise the usual single card,
  // which a Plus (or a King's free turn) only allows once nothing is playable.
  const owed = state.pendingDraw;
  if (
    owed === 0 &&
    state.pendingPlus &&
    hasPlayableCard(state.hands[playerId] ?? [], playContextFromState(state))
  ) {
    return reject('mustPlayAfterPlus');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];
  drawCards(draft, playerId, owed > 0 ? owed : 1, events);
  draft.pendingDraw = 0;
  draft.pendingPlus = false;
  draft.freePlay = false;
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

  // While a +3 is waiting for an answer the table is frozen for everyone, and
  // the only two moves are a breaker or a pass — from any seat, not just the
  // one to move. That is the whole point of the card.
  if (state.plusThree) {
    switch (command.type) {
      case 'playCard':
        return applyPlayCard(state, command.playerId, command.cardId, command.chosenColor);
      case 'passBreak':
        return applyPassBreak(state, command.playerId);
      default:
        return reject('awaitingBreak');
    }
  }
  if (command.type === 'passBreak') {
    return reject('noPlusThreeOpen');
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
