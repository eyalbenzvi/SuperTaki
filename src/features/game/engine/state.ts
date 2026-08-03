import type { Card, CardColor, CardId } from './cards.ts';
import type { RngState } from './prng.ts';

export type PlayerId = string;

/** Turn direction: `1` follows the seating order, `-1` reverses it. */
export type TurnDirection = 1 | -1;

export interface EnginePlayer {
  readonly id: PlayerId;
  readonly name: string;
}

/** State of an open Taki sequence. */
export interface TakiModeState {
  /** Colour the sequence is locked to. */
  readonly color: CardColor;
  /** Player who owns the sequence. */
  readonly playerId: PlayerId;
  /** Number of cards played since (and including) the opening card. */
  readonly cardsPlayed: number;
  /** Whether the sequence was opened by a Super Taki (wild) card. */
  readonly openedWithSuperTaki: boolean;
}

/**
 * A +3 waiting to be answered.
 *
 * Anyone holding a +3 Breaker may play it out of turn to send the three cards
 * back at whoever played the +3. `awaiting` lists exactly those players, so a
 * table where nobody holds a breaker resolves the +3 without pausing. It never
 * leaves the host: the public state only says that a +3 is open, and a client
 * works out whether it may answer from its own hand.
 */
export interface PlusThreeState {
  /** Player who played the +3. */
  readonly playerId: PlayerId;
  /** Players who hold a +3 Breaker and have not answered yet. */
  readonly awaiting: readonly PlayerId[];
}

export type GamePhase = 'playing' | 'finished';

/**
 * Complete authoritative game state. Serialisable, never mutated in place.
 * Only the host holds a full copy (it contains every hand).
 */
export interface GameState {
  /** Monotonic version, incremented on every accepted command. */
  readonly version: number;
  readonly phase: GamePhase;
  readonly players: readonly EnginePlayer[];
  /** Hands keyed by player id. Private information. */
  readonly hands: Readonly<Record<PlayerId, readonly Card[]>>;
  /** Face-down pile; index 0 is the next card to be drawn. */
  readonly drawPile: readonly Card[];
  /** Face-up pile; the last element is the visible top card. */
  readonly discardPile: readonly Card[];
  /** Colour that must currently be matched. */
  readonly activeColor: CardColor;
  readonly direction: TurnDirection;
  readonly currentPlayerIndex: number;
  readonly takiMode: TakiModeState | null;
  /**
   * Set after a Plus card resolves: the same player owes one more card
   * (or a draw, if they hold nothing legal).
   */
  readonly pendingPlus: boolean;
  /**
   * Cards the player to move must draw unless they answer with another +2 or a
   * King. Grows by two for every +2 added to the run.
   */
  readonly pendingDraw: number;
  /**
   * Set by a King: the same player plays again and may play anything, whatever
   * the leading colour or symbol is.
   */
  readonly freePlay: boolean;
  /** Open +3 waiting for the breaker window to close, or `null`. */
  readonly plusThree: PlusThreeState | null;
  /**
   * Players who have declared "last card" for the single card they are holding
   * now. A player leaves this list the moment their hand stops being exactly one
   * card, so coming back down to one card needs a fresh declaration.
   */
  readonly declaredLastCard: readonly PlayerId[];
  readonly rng: RngState;
  readonly winnerId: PlayerId | null;
  /** Seed the game was created with, kept for reproducibility/debugging. */
  readonly seed: number;
}

export type GameCommand =
  | {
      readonly type: 'playCard';
      readonly playerId: PlayerId;
      readonly cardId: CardId;
      /** Required for wild cards, forbidden otherwise. */
      readonly chosenColor?: CardColor;
    }
  | { readonly type: 'drawCard'; readonly playerId: PlayerId }
  | { readonly type: 'closeTaki'; readonly playerId: PlayerId }
  /** Declines to answer an open +3 with a +3 Breaker. */
  | { readonly type: 'passBreak'; readonly playerId: PlayerId }
  /**
   * Declares "last card". Legal from any seat, in or out of turn, and only while
   * the declaring player holds exactly one card.
   */
  | { readonly type: 'declareLastCard'; readonly playerId: PlayerId };

export type GameCommandType = GameCommand['type'];

export type GameEvent =
  | { readonly type: 'gameStarted'; readonly firstPlayerId: PlayerId; readonly activeColor: CardColor }
  | {
      readonly type: 'cardPlayed';
      readonly playerId: PlayerId;
      readonly card: Card;
      readonly resultingColor: CardColor;
    }
  | { readonly type: 'cardDrawn'; readonly playerId: PlayerId; readonly count: number }
  | {
      readonly type: 'takiOpened';
      readonly playerId: PlayerId;
      readonly color: CardColor;
      readonly superTaki: boolean;
    }
  | { readonly type: 'takiClosed'; readonly playerId: PlayerId; readonly cardsPlayed: number }
  | { readonly type: 'colorChosen'; readonly playerId: PlayerId; readonly color: CardColor }
  | { readonly type: 'playerSkipped'; readonly playerId: PlayerId }
  /** A +2 was added to the run; `total` is what the next player now owes. */
  | { readonly type: 'drawStacked'; readonly playerId: PlayerId; readonly total: number }
  /** A King wiped the pending penalty and/or obligation off the table. */
  | { readonly type: 'effectsCancelled'; readonly playerId: PlayerId }
  /** A +3 was played and is waiting for a possible breaker. */
  | { readonly type: 'plusThreePlayed'; readonly playerId: PlayerId }
  /** A +3 Breaker sent the penalty back at `targetId`. */
  | { readonly type: 'plusThreeBroken'; readonly playerId: PlayerId; readonly targetId: PlayerId }
  /** A player declared "last card" while holding their final card. */
  | { readonly type: 'lastCardDeclared'; readonly playerId: PlayerId }
  /**
   * A player emptied their hand without having declared "last card". They drew
   * the penalty instead of winning; `penalty` is how many cards they actually got.
   */
  | { readonly type: 'lastCardMissed'; readonly playerId: PlayerId; readonly penalty: number }
  | { readonly type: 'directionChanged'; readonly direction: TurnDirection }
  | { readonly type: 'extraTurn'; readonly playerId: PlayerId }
  | { readonly type: 'turnChanged'; readonly playerId: PlayerId }
  | { readonly type: 'drawPileRecycled'; readonly count: number }
  | { readonly type: 'drawPileExhausted' }
  | { readonly type: 'playerWon'; readonly playerId: PlayerId };

export type GameEventType = GameEvent['type'];

/** Machine-readable rejection codes; the UI maps them to localised strings. */
export const REJECTION_CODES = [
  'gameFinished',
  'unknownPlayer',
  'notYourTurn',
  'cardNotInHand',
  'illegalCard',
  'colorRequired',
  'colorNotAllowed',
  'mustPlayAfterPlus',
  'mustAnswerDraw',
  'awaitingBreak',
  'noPlusThreeOpen',
  'cannotDrawDuringTaki',
  'noTakiOpen',
  'wildNotAllowedInTaki',
  'wrongTakiColor',
  'nothingToDeclare',
  'alreadyDeclared',
  'notEnoughPlayers',
  'tooManyPlayers',
  'duplicatePlayerId',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface CommandRejection {
  readonly code: RejectionCode;
}

export type CommandResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly rejection: CommandRejection };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
