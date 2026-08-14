import {
  CARDS_DEALT_PER_PLAYER,
  LAST_CARD_PENALTY,
  PLUS_THREE_PENALTY,
  PLUS_TWO_PENALTY,
  STAIRS_STAGES,
  buildDeck,
  cardColor,
  isCardColor,
  isNumberCard,
  isTakiCard,
  isWildCard,
  requiresColorChoice,
  stairsHandSize,
  type Card,
  type CardColor,
} from './cards.ts';
import { createRng, shuffle, type RngState } from './prng.ts';
import { isCardPlayable, stepIndex, type PlayContext } from './rules.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type CommandResult,
  type EnginePlayer,
  type GameCommand,
  type GameEndReason,
  type GameEvent,
  type GameMode,
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
  mode: GameMode;
  stairs: Record<PlayerId, number>;
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
  declaredLastCard: PlayerId[];
  rng: RngState;
  winnerId: PlayerId | null;
  endReason: GameEndReason | null;
  turnSeq: number;
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
    mode: state.mode,
    stairs: { ...state.stairs },
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
    declaredLastCard: state.declaredLastCard.slice(),
    rng: state.rng,
    winnerId: state.winnerId,
    endReason: state.endReason,
    turnSeq: state.turnSeq,
    seed: state.seed,
  };
}

/**
 * Drops declarations that no longer describe a hand of one card.
 *
 * A declaration belongs to the single card a player is holding, not to the
 * player: whoever draws back up owes a fresh declaration next time they come
 * down to one. Applied at the end of every command, so no code path can leave a
 * stale declaration behind for the win check to honour.
 */
function syncDeclarations(draft: Draft): void {
  draft.declaredLastCard = draft.declaredLastCard.filter(
    (playerId) => (draft.hands[playerId] ?? []).length === 1,
  );
}

function freeze(draft: Draft): GameState {
  syncDeclarations(draft);
  return {
    version: draft.version,
    phase: draft.phase,
    mode: draft.mode,
    stairs: draft.stairs,
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
    declaredLastCard: draft.declaredLastCard,
    rng: draft.rng,
    winnerId: draft.winnerId,
    endReason: draft.endReason,
    turnSeq: draft.turnSeq,
    seed: draft.seed,
  };
}

/** Players still in the round. A `left` seat keeps its cards but takes no turns. */
export function activePlayers(state: Pick<GameState, 'players'>): readonly EnginePlayer[] {
  return state.players.filter((player) => player.left !== true);
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
    takiSwitchOpen: state.takiMode?.takisOnly ?? false,
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
 *
 * `mode` is fixed here and never again: a round is won the way it was dealt. Both
 * modes open with the same eight cards, so nothing about this function's deal
 * depends on it — in "stairs" the difference begins the first time somebody runs
 * out. See {@link GameMode}.
 */
export function createGame(
  players: readonly EnginePlayer[],
  seed: number,
  initialVersion = 1,
  startingSeat = 0,
  mode: GameMode = 'classic',
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
  /*
   * The host holds seat 0 for the life of the room, so a fixed starting index
   * meant the host moved first in every round, for ever. A table notices that by
   * about the fifth round.
   */
  const firstIndex = ((startingSeat % players.length) + players.length) % players.length;
  const stairs: Record<PlayerId, number> = {};
  for (const player of players) {
    stairs[player.id] = 0;
  }
  const state: GameState = {
    version: initialVersion,
    phase: 'playing',
    mode,
    stairs,
    players,
    hands,
    drawPile,
    discardPile: [opening],
    activeColor: opening.color,
    direction: 1,
    currentPlayerIndex: firstIndex,
    takiMode: null,
    pendingPlus: false,
    pendingDraw: 0,
    freePlay: false,
    plusThree: null,
    declaredLastCard: [],
    rng,
    winnerId: null,
    endReason: null,
    turnSeq: 0,
    seed,
  };

  const firstPlayer = players[firstIndex] as EnginePlayer;
  const events: GameEvent[] = [
    { type: 'gameStarted', firstPlayerId: firstPlayer.id, activeColor: opening.color },
    { type: 'turnChanged', playerId: firstPlayer.id },
  ];
  return { ok: true, state, events };
}

/**
 * Moves the turn on, stepping over seats that have left.
 *
 * The loop is bounded by the seat count, so a table where everybody has left
 * cannot spin: it lands back where it started and the caller's own end-of-round
 * check deals with it.
 */
function nextActiveIndex(draft: Draft, from: number): number {
  let index = from;
  for (let step = 0; step < draft.players.length; step += 1) {
    index = stepIndex(index, draft.direction, draft.players.length);
    if ((draft.players[index] as EnginePlayer).left !== true) {
      return index;
    }
  }
  return from;
}

function advanceTurn(draft: Draft, events: GameEvent[]): void {
  draft.currentPlayerIndex = nextActiveIndex(draft, draft.currentPlayerIndex);
  const next = draft.players[draft.currentPlayerIndex] as EnginePlayer;
  draft.turnSeq += 1;
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
      // A player who has left the round pays nothing: their hand is out of play.
      if (player.id !== sourceId && player.left !== true) {
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
        player.left !== true &&
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
      // Whoever the Stop lands on has to be somebody still playing, or the card
      // would be spent on an empty seat and the next live player would be robbed
      // of their turn instead.
      const skippedIndex = nextActiveIndex(draft, draft.currentPlayerIndex);
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
      /*
       * The King buys its owner a turn with no matching at all, and on the way it
       * wipes whatever +2 run was owed. Both halves are the same card: the run
       * disappears — however high it had been stacked — and the player who wiped
       * it plays on instead of drawing. The cancellation is announced separately
       * from the free turn because the number of cards nobody is drawing is the
       * part of the moment the table cares about.
       */
      const player = draft.players[draft.currentPlayerIndex] as EnginePlayer;
      const cancelled = draft.pendingDraw;
      draft.pendingDraw = 0;
      draft.pendingPlus = true;
      draft.freePlay = true;
      if (cancelled > 0) {
        events.push({ type: 'drawRunCancelled', playerId: player.id, cancelled });
      }
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
  declareLastCard: boolean,
): CommandResult {
  const hand = state.hands[playerId] ?? [];
  const card = hand.find((candidate) => candidate.id === cardId);
  if (!card) {
    return reject('cardNotInHand');
  }

  // While a +3 is open nothing may be played but a breaker, and only by somebody
  // being waited for — not even by the player whose turn it is.
  const answeringPlusThree = state.plusThree !== null && card.kind === 'breakPlusThree';
  if (state.plusThree !== null && (!answeringPlusThree || !state.plusThree.awaiting.includes(playerId))) {
    return reject('awaitingBreak');
  }
  // A breaker with no +3 to break is a legal card, and an expensive one — see
  // the penalty below.
  const spendingBreaker = state.plusThree === null && card.kind === 'breakPlusThree';

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
      /*
       * Colour is the rule inside a sequence, with one opening: a Taki laid
       * straight onto another Taki continues the run whatever it is printed on,
       * and may do so only while nothing but Takis have been played. A coloured
       * Taki takes the run into its own colour; a Super Taki has none and leaves
       * it where it is, which is the only difference between them here. After an
       * ordinary card the colour is settled, and no later Taki reopens it.
       */
      const carriesTheRun = state.takiMode.takisOnly && isTakiCard(card);
      if (!carriesTheRun) {
        if (isWildCard(card)) {
          return reject('wildNotAllowedInTaki');
        }
        if (card.color !== state.takiMode.color) {
          return reject('wrongTakiColor');
        }
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

  /*
   * A breaker with nothing to break costs its owner the three cards it would
   * have sent back — charged here, before the win check, so it cannot be used as
   * a free way out of a last card.
   */
  if (spendingBreaker) {
    const penaltyEvents: GameEvent[] = [];
    const penalty = drawCards(draft, playerId, PLUS_THREE_PENALTY, penaltyEvents);
    events.push({ type: 'breakerSpent', playerId, penalty }, ...penaltyEvents);
  }

  /*
   * A Plus is an obligation to play again, and an empty hand has nothing to meet
   * it with. So a Plus never empties a hand: its owner takes from the pile the
   * card the obligation is worth — a Plus may always be paid that way — and the
   * turn moves on with them holding the single card they have just drawn. A round
   * therefore cannot be won on a Plus, and in "stairs" a Plus is not a step of the
   * staircase either. Both would be the same incoherence: an obligation to act
   * met by having nothing left to act with.
   *
   * The one case where the hand stays empty is a pile with nothing in it, discard
   * included. Nothing can be taken, so nothing is, and the win check below takes
   * the moment instead — a round that cannot go on has to end somewhere, and the
   * player holding no cards is where.
   */
  let refilledOnPlus = false;
  if (card.kind === 'plus' && (draft.hands[playerId] ?? []).length === 0) {
    const refillEvents: GameEvent[] = [];
    if (drawCards(draft, playerId, 1, refillEvents) === 0) {
      // Nothing anywhere to take. The pile says so — the line is the only
      // explanation the table gets for a round that ended on a Plus after all.
      events.push(...refillEvents);
    } else {
      refilledOnPlus = true;
      /*
       * The declaration went with the card that has just gone down, and that card
       * was their last. What replaces it is a card nobody has claimed, so the
       * shout is owed again — `syncDeclarations` would otherwise keep the old one
       * alive for it, the hand being a single card either way.
       */
      draft.declaredLastCard = draft.declaredLastCard.filter((candidate) => candidate !== playerId);
      events.push({ type: 'plusRefilled', playerId }, ...refillEvents);
    }
  }

  /*
   * The hand is empty. In a classic round that is the round; in "stairs" it is one
   * step of it, and only the eighth step wins.
   *
   * The step is taken *here*, in the gap the win check used to occupy, because
   * everything below this point assumes a settled hand — the shout, the sequence
   * bookkeeping, the card's own effect. A redealt player carries on with the turn
   * they were in the middle of: a Plus still buys them another card to play, a
   * Taki still opens a sequence, a Stop still skips the next seat. That is the
   * whole reason the redeal is not a separate command.
   */
  let redealt = false;
  if ((draft.hands[playerId] ?? []).length === 0) {
    // `null` in a classic round: there is no staircase to be a step of.
    const step = draft.mode === 'stairs' ? (draft.stairs[playerId] ?? 0) + 1 : null;
    if (step !== null) {
      draft.stairs = { ...draft.stairs, [playerId]: step };
    }
    if (step !== null && step < STAIRS_STAGES) {
      redealt = true;
      /*
       * The declaration goes with the card that was in the hand, and that card has
       * just been played. A step down to a single card — the last one — therefore
       * needs its own shout, or `syncDeclarations` would keep the old one alive for
       * a card nobody has claimed and hand out a protection that was never earned.
       */
      draft.declaredLastCard = draft.declaredLastCard.filter((candidate) => candidate !== playerId);
      const dealEvents: GameEvent[] = [];
      const dealt = drawCards(draft, playerId, stairsHandSize(step), dealEvents);
      events.push(
        { type: 'stairsAdvanced', playerId, stage: step, dealt },
        // `dealt` already says how many cards arrived, so the draw's own line would
        // say it twice. What is kept is what the *pile* did, which is nobody's move.
        ...dealEvents.filter((event) => event.type !== 'cardDrawn'),
      );
    } else {
      draft.phase = 'finished';
      draft.winnerId = playerId;
      draft.endReason = 'won';
      draft.takiMode = null;
      draft.pendingPlus = false;
      draft.pendingDraw = 0;
      draft.plusThree = null;
      events.push({ type: 'playerWon', playerId });
      draft.version += 1;
      return { ok: true, state: freeze(draft), events };
    }
  }

  /*
   * The shout, when it was made with the card rather than after it.
   *
   * Here and not earlier, because "the card left me on one" is only true once the
   * hand is settled — a breaker's penalty has already been drawn above, and the
   * win check above has already taken the case where nothing is left to declare.
   * Nothing below this point adds to or removes from *this* player's hand, so the
   * count cannot change again inside this command.
   *
   * A hand that arrived from a step of the staircase is not covered by it, and
   * neither is the card a Plus took from the pile: the shout was armed about the
   * card going down, not about whatever replaced it, and a player looking at a
   * card they have only just drawn has a fresh declaration to make.
   */
  if (
    declareLastCard &&
    !redealt &&
    !refilledOnPlus &&
    (draft.hands[playerId] ?? []).length === 1 &&
    !draft.declaredLastCard.includes(playerId)
  ) {
    draft.declaredLastCard.push(playerId);
    events.push({ type: 'lastCardDeclared', playerId });
  }

  if (answeringPlusThree) {
    resolvePlusThree(draft, playerId, events);
  } else if (draft.takiMode) {
    /*
     * Inside a sequence: accumulate; effects are resolved when the Taki closes.
     *
     * The colour follows the run rather than the opening card, because a coloured
     * Taki played onto a Taki carries it over — `resultingColor` is that card's
     * own colour, and the validation above has already refused the move unless
     * the run was still nothing but Takis. Everything else leaves the colour
     * alone: an ordinary card had to match it to be here at all, and a Super Taki
     * has no colour of its own, so `resultingColor` falls back to the one the run
     * is already in.
     */
    const takisOnly = draft.takiMode.takisOnly && isTakiCard(card);
    draft.takiMode = {
      ...draft.takiMode,
      color: resultingColor,
      cardsPlayed: draft.takiMode.cardsPlayed + 1,
      takisOnly,
      // A sequence that has been carried into a coloured Taki's colour is no
      // longer the Super Taki's, whatever opened it.
      openedWithSuperTaki: draft.takiMode.openedWithSuperTaki && card.kind !== 'taki',
    };
  } else if (isTakiCard(card)) {
    draft.takiMode = {
      color: resultingColor,
      playerId,
      cardsPlayed: 1,
      openedWithSuperTaki: card.kind === 'superTaki',
      takisOnly: true,
    };
    events.push({
      type: 'takiOpened',
      playerId,
      color: resultingColor,
      superTaki: card.kind === 'superTaki',
    });
  } else if (refilledOnPlus) {
    /*
     * The card this Plus owed came from the pile, and a Plus paid from the pile
     * ends the turn — which is what the obligation says on every other turn too.
     * Calling `resolveCardEffect` here would hand its owner a free turn for
     * having run out, and the drawn card back as a win.
     */
    advanceTurn(draft, events);
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

/**
 * Declares "last card".
 *
 * Legal from any seat and at any moment, exactly as it is at a real table: the
 * declaration goes with the card in your hand, not with your turn. It is only
 * ever legal while the declaring player holds exactly one card, and only once
 * per card.
 */
function applyDeclareLastCard(state: GameState, playerId: PlayerId): CommandResult {
  if ((state.hands[playerId] ?? []).length !== 1) {
    return reject('nothingToDeclare');
  }
  if (state.declaredLastCard.includes(playerId)) {
    return reject('alreadyDeclared');
  }

  const draft = toDraft(state);
  draft.declaredLastCard.push(playerId);
  draft.version += 1;
  return { ok: true, state: freeze(draft), events: [{ type: 'lastCardDeclared', playerId }] };
}

/**
 * Catches a player sitting silently on a single card.
 *
 * The declaration is not what wins the round — putting the last card down is.
 * What silence costs is being caught: any other player may call it, in or out of
 * turn, for as long as the hand stays at one undeclared card. Drawing the penalty
 * ends the exposure by itself, since the hand is no longer a single card.
 */
function applyCatchLastCard(state: GameState, playerId: PlayerId, targetId: PlayerId): CommandResult {
  const target = state.players.find((player) => player.id === targetId);
  // A player who has left cannot be caught: their hand is frozen out of play, and
  // they are in no position to shout.
  if (!target || target.left === true || targetId === playerId) {
    return reject('nothingToCatch');
  }
  if ((state.hands[targetId] ?? []).length !== 1 || state.declaredLastCard.includes(targetId)) {
    return reject('nothingToCatch');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];
  const penaltyEvents: GameEvent[] = [];
  const penalty = drawCards(draft, targetId, LAST_CARD_PENALTY, penaltyEvents);
  events.push(
    { type: 'lastCardCaught', playerId: targetId, caughtById: playerId, penalty },
    ...penaltyEvents,
  );

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

/**
 * Passes the turn of a player who is not there, at the price of the turn.
 *
 * This is its own transition rather than a `drawCard` issued on somebody's behalf,
 * and it has to be: the engine refuses to draw during an open Taki, so a skip built
 * out of `drawCard` would be rejected in exactly the state where a table is most
 * likely to be stuck. It also answers with its own rejection code, because the
 * caller is the room acting on a timer rather than a player taking a turn.
 *
 * The order below matters and each step re-reads the state the previous one left:
 *
 * 1. A Taki sequence the absent player owns is closed *properly*, through the
 *    real close transition, so the last card's effect is applied once and only
 *    once. Only a Plus leaves the turn with them afterwards; a number, Taki,
 *    Super Taki, Stop, Change Direction or +2 has already moved it on, and adding
 *    another advance here would skip an innocent player — two of them after a
 *    Stop. A colourless card cannot end a sequence, so those seven cases are
 *    exhaustive. A close is a move that was actually made, so nothing is charged
 *    for it; it is only what is left of the turn afterwards that is skipped.
 * 2. An outstanding +2 run is paid in full. It is an obligation somebody else
 *    created, and voiding it would either destroy cards or dump the run on the
 *    next seat, who did nothing to deserve it.
 * 3. Every other skip costs one card from the pile — the same card the same turn
 *    would have cost had they been there to take it. A free pass was the cheapest
 *    turn at the table: a hand that cannot grow cannot lose, so a seat that dropped
 *    out at the right moment came out ahead of one that played, and orbiting a
 *    disconnected player cost them nothing at all. Ending the turn by taking the
 *    pile is what the rules already say happens when nothing is played.
 */
function applySkipTurn(state: GameState, playerId: PlayerId): CommandResult {
  if (currentPlayer(state)?.id !== playerId) {
    return reject('nothingToSkip');
  }

  // Step 1: close their sequence through the transition that already knows how.
  if (state.takiMode !== null) {
    const closed = applyCloseTaki(state, playerId);
    if (!closed.ok) {
      return closed;
    }
    // Still their turn only if the sequence ended on a Plus; otherwise done.
    if (currentPlayer(closed.state)?.id !== playerId) {
      return closed;
    }
    const after = applySkipTurn(closed.state, playerId);
    return after.ok ? { ok: true, state: after.state, events: [...closed.events, ...after.events] } : closed;
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];

  // The owed run when there is one, otherwise the single card any turn that plays
  // nothing costs. `drew` can still come back short — the pile can run dry.
  const owed = state.pendingDraw;
  const drew = drawCards(draft, playerId, owed > 0 ? owed : 1, events);

  draft.pendingDraw = 0;
  draft.pendingPlus = false;
  draft.freePlay = false;
  events.push({ type: 'turnSkipped', playerId, drew });
  advanceTurn(draft, events);
  draft.version += 1;
  return { ok: true, state: freeze(draft), events };
}

/**
 * Marks a player as gone without disturbing the round.
 *
 * Everything they were holding up is released first — a sequence they owned, a
 * breaker window waiting on them, a declaration — because leaving those dangling
 * is what deadlocks a table permanently. Their cards stay frozen in their hand,
 * out of play: no reshuffle, no random numbers consumed, and the total number of
 * cards in the system is unchanged, which is the invariant the tests assert.
 */
function applyLeaveGame(state: GameState, playerId: PlayerId): CommandResult {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) {
    return reject('unknownPlayer');
  }
  if (player.left === true) {
    return reject('alreadyLeft');
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];
  const wasCurrent = currentPlayer(state)?.id === playerId;

  draft.players = draft.players.map((candidate) =>
    candidate.id === playerId ? { ...candidate, left: true } : candidate,
  );
  draft.declaredLastCard = draft.declaredLastCard.filter((candidate) => candidate !== playerId);
  events.push({ type: 'playerLeft', playerId });

  // A sequence whose owner has gone can never be closed and can never be drawn
  // out of, so it has to go with them.
  if (draft.takiMode?.playerId === playerId) {
    draft.takiMode = null;
  }

  if (draft.plusThree !== null) {
    if (draft.plusThree.playerId === playerId) {
      // The +3's author has left: cancel it outright rather than charging a table
      // for a card nobody can now answer.
      draft.plusThree = null;
    } else {
      const awaiting = draft.plusThree.awaiting.filter((candidate) => candidate !== playerId);
      if (awaiting.length === 0) {
        resolvePlusThree(draft, null, events);
      } else {
        draft.plusThree = { ...draft.plusThree, awaiting };
      }
    }
  }

  const remaining = draft.players.filter((candidate) => candidate.left !== true);
  if (remaining.length < MIN_PLAYERS) {
    // No winner. "Last player standing" would hand a two-player host the round
    // for a twenty-second blip they themselves measured.
    draft.phase = 'finished';
    draft.winnerId = null;
    draft.endReason = 'abandoned';
    draft.takiMode = null;
    draft.plusThree = null;
    draft.pendingDraw = 0;
    draft.pendingPlus = false;
    draft.freePlay = false;
    events.push({ type: 'roundAbandoned' });
    draft.version += 1;
    return { ok: true, state: freeze(draft), events };
  }

  // The turn pointer must never rest on an empty seat.
  if (wasCurrent && draft.plusThree === null) {
    draft.pendingDraw = 0;
    draft.pendingPlus = false;
    draft.freePlay = false;
    advanceTurn(draft, events);
  } else if ((draft.players[draft.currentPlayerIndex] as EnginePlayer).left === true) {
    draft.currentPlayerIndex = nextActiveIndex(draft, draft.currentPlayerIndex);
    draft.turnSeq += 1;
    events.push({
      type: 'turnChanged',
      playerId: (draft.players[draft.currentPlayerIndex] as EnginePlayer).id,
    });
  }

  draft.version += 1;
  return { ok: true, state: freeze(draft), events };
}

/**
 * Stops the round with no winner and everybody's hand intact.
 *
 * Nobody is marked as having left: the point is that the *round* ended, not that
 * these players did anything. The standings show exactly where everyone was.
 */
function applyAbandonRound(state: GameState): CommandResult {
  const draft = toDraft(state);
  draft.phase = 'finished';
  draft.winnerId = null;
  draft.endReason = 'abandoned';
  draft.takiMode = null;
  draft.plusThree = null;
  draft.pendingDraw = 0;
  draft.pendingPlus = false;
  draft.freePlay = false;
  draft.version += 1;
  return { ok: true, state: freeze(draft), events: [{ type: 'roundAbandoned' }] };
}

function applyDrawCard(state: GameState, playerId: PlayerId): CommandResult {
  if (state.takiMode) {
    return reject('cannotDrawDuringTaki');
  }
  /*
   * A pending +2 run must be paid in full; otherwise the usual single card.
   *
   * A Plus obligation — and the free turn a King grants, which is the same flag —
   * no longer forces a play. The card you owe after a Plus may be paid from the
   * pile instead, exactly like any other turn, and drawing ends the turn as it
   * always does. The old rule made the obligation the one place in the game where
   * the pile was disabled while the player still held something legal, which is
   * both a rule nobody at a real table enforces and the only screen where a lit
   * draw pile could refuse a tap.
   */
  const owed = state.pendingDraw;

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

  // Marking a player as gone is the one command a departed seat is the subject of.
  if (command.type === 'leaveGame') {
    return applyLeaveGame(state, command.playerId);
  }
  if (command.type === 'abandonRound') {
    return applyAbandonRound(state);
  }
  if (actor.left === true) {
    return reject('alreadyLeft');
  }

  // Declaring, and calling out somebody who did not, are shouts rather than
  // moves: they belong to the cards in hand and are legal from any seat, whatever
  // else the table happens to be waiting for.
  if (command.type === 'declareLastCard') {
    return applyDeclareLastCard(state, command.playerId);
  }
  if (command.type === 'catchLastCard') {
    return applyCatchLastCard(state, command.playerId, command.targetId);
  }

  // While a +3 is waiting for an answer the table is frozen for everyone, and
  // the only two moves are a breaker or a pass — from any seat, not just the
  // one to move. That is the whole point of the card.
  if (state.plusThree) {
    switch (command.type) {
      case 'playCard':
        return applyPlayCard(
          state,
          command.playerId,
          command.cardId,
          command.chosenColor,
          command.declareLastCard === true,
        );
      case 'passBreak':
        return applyPassBreak(state, command.playerId);
      default:
        return reject('awaitingBreak');
    }
  }
  if (command.type === 'passBreak') {
    return reject('noPlusThreeOpen');
  }
  /*
   * Skipping answers with its own code rather than the generic "not your turn",
   * because the caller is the host acting on a timer and the distinction is what
   * the diagnostics log needs: being asked to skip the wrong seat is a bug in the
   * absence machinery, not a player mistake.
   */
  if (command.type === 'skipTurn') {
    return applySkipTurn(state, command.playerId);
  }
  if (currentPlayer(state)?.id !== command.playerId) {
    return reject('notYourTurn');
  }

  switch (command.type) {
    case 'playCard':
      return applyPlayCard(
        state,
        command.playerId,
        command.cardId,
        command.chosenColor,
        command.declareLastCard === true,
      );
    case 'closeTaki':
      return applyCloseTaki(state, command.playerId);
    case 'drawCard':
      return applyDrawCard(state, command.playerId);
  }
}
