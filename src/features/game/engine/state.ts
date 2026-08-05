import type { Card, CardColor, CardId } from './cards.ts';
import type { RngState } from './prng.ts';

export type PlayerId = string;

/** Turn direction: `1` follows the seating order, `-1` reverses it. */
export type TurnDirection = 1 | -1;

export interface EnginePlayer {
  readonly id: PlayerId;
  readonly name: string;
  /**
   * Set when a player has left the round for good.
   *
   * They are *marked*, never removed from `players`, and that is a deliberate
   * design decision rather than laziness. Splicing a seat out mid-round breaks
   * five things at once: a Taki sequence they owned can never be closed and never
   * be drawn out of, so the table deadlocks permanently; a `plusThree.awaiting`
   * entry naming them can never empty, so every command from every seat is
   * refused for the rest of the game; `currentPlayerIndex` silently points at the
   * wrong player whenever the removed seat sat before it; the public state drops
   * below the two players the wire schema requires, so the final broadcast is
   * unparseable and nobody sees the round end; and the player vanishes from the
   * standings of a round they may have been winning.
   *
   * Marking costs one flag and one condition inside `advanceTurn`. Card
   * conservation then holds by construction — their hand is simply frozen out of
   * play, with no reshuffle and no random numbers consumed.
   */
  readonly left?: boolean;
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
 * Why a round ended.
 *
 * `abandoned` exists because "the last player standing wins" is not a result. A
 * two-player table whose opponent's phone blinks for twenty seconds would hand the
 * round to whoever was left, and the host is the one measuring the blink. A round
 * that runs out of players has no winner, and says so.
 */
export type GameEndReason = 'won' | 'abandoned';

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
   * Set after a Plus card resolves: the same player plays again.
   *
   * An obligation, not a compulsion — they may pay it from the draw pile instead,
   * whatever they are holding, and drawing ends the turn as it always does.
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
  /** Why the round ended, or `null` while it is still running. */
  readonly endReason: GameEndReason | null;
  /**
   * Counts turn handovers, not commands.
   *
   * `version` moves for everything, including the out-of-turn declarations and
   * catches that are legal at any moment — which makes it useless as a way for a
   * client to ask "is my move still meant for the table I was looking at?". This
   * does answer that, because it changes only when the turn does.
   */
  readonly turnSeq: number;
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
  | { readonly type: 'declareLastCard'; readonly playerId: PlayerId }
  /**
   * Catches `targetId` holding a single card they never declared. Legal from any
   * seat but their own, in or out of turn, for as long as they stay silent.
   */
  | { readonly type: 'catchLastCard'; readonly playerId: PlayerId; readonly targetId: PlayerId }
  /**
   * Passes the turn of a player who is not there.
   *
   * Host-only: it is deliberately absent from the wire protocol, because a client
   * that could ask for it could skip anybody. See `docs/rules.md` for the full
   * rule table — the short version is that a skip is *free*. A disconnect is not a
   * decision, and charging a card for it would leave a returning player several
   * cards down after a seat had been faithfully held for them, which would make
   * the whole promise of holding it theatre. The one thing that does not
   * evaporate is a penalty somebody *else* created: an outstanding +2 run is paid
   * in full, or pulling the plug becomes the cheapest answer to an eight-card run.
   */
  | { readonly type: 'skipTurn'; readonly playerId: PlayerId }
  /** Marks a player as having left for good, without disturbing the round. */
  | { readonly type: 'leaveGame'; readonly playerId: PlayerId }
  /**
   * Ends the round with no winner, by agreement of the table.
   *
   * This is what a real table does when somebody has to leave: you stop, and
   * nobody pretends the interrupted hand produced a champion. Having it removes
   * most of the reason to attempt an automatic host takeover, which cannot be made
   * safe in a topology with no authority.
   */
  | { readonly type: 'abandonRound'; readonly playerId: PlayerId };

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
  /** A Taki played on a Taki carried the open sequence into a new colour. */
  | { readonly type: 'takiColorChanged'; readonly playerId: PlayerId; readonly color: CardColor }
  | { readonly type: 'colorChosen'; readonly playerId: PlayerId; readonly color: CardColor }
  | { readonly type: 'playerSkipped'; readonly playerId: PlayerId }
  /** A +2 was added to the run; `total` is what the next player now owes. */
  | { readonly type: 'drawStacked'; readonly playerId: PlayerId; readonly total: number }
  /**
   * A King wiped an open +2 run. `cancelled` is how many cards `playerId` was
   * owing and no longer draws — the number is the whole point of the line, so it
   * travels with the event rather than being read back off a state that has
   * already been cleared.
   */
  | { readonly type: 'drawRunCancelled'; readonly playerId: PlayerId; readonly cancelled: number }
  /** A +3 was played and is waiting for a possible breaker. */
  | { readonly type: 'plusThreePlayed'; readonly playerId: PlayerId }
  /** A +3 Breaker sent the penalty back at `targetId`. */
  | { readonly type: 'plusThreeBroken'; readonly playerId: PlayerId; readonly targetId: PlayerId }
  /** A player declared "last card" while holding their final card. */
  | { readonly type: 'lastCardDeclared'; readonly playerId: PlayerId }
  /**
   * `caughtById` caught `playerId` sitting silently on a single card. `penalty`
   * is how many cards they actually drew.
   */
  | {
      readonly type: 'lastCardCaught';
      readonly playerId: PlayerId;
      readonly caughtById: PlayerId;
      readonly penalty: number;
    }
  /**
   * A +3 Breaker was played with no +3 to break, so it cost its owner the three
   * cards instead. `penalty` is how many they actually drew.
   */
  | { readonly type: 'breakerSpent'; readonly playerId: PlayerId; readonly penalty: number }
  | { readonly type: 'directionChanged'; readonly direction: TurnDirection }
  | { readonly type: 'extraTurn'; readonly playerId: PlayerId }
  | { readonly type: 'turnChanged'; readonly playerId: PlayerId }
  | { readonly type: 'drawPileRecycled'; readonly count: number }
  | { readonly type: 'drawPileExhausted' }
  | { readonly type: 'playerWon'; readonly playerId: PlayerId }
  /** A turn was passed for somebody who was not there. `drew` is what they owed. */
  | { readonly type: 'turnSkipped'; readonly playerId: PlayerId; readonly drew: number }
  | { readonly type: 'playerLeft'; readonly playerId: PlayerId }
  /** The round ran out of players. There is no winner. */
  | { readonly type: 'roundAbandoned' };

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
  /**
   * Retired: a Plus obligation may now be paid from the draw pile.
   *
   * The engine never emits it any more, and the code stays in the vocabulary
   * because an older host on a mixed table still does — removing a value from the
   * enum would fail that message's schema and lock the receiving player's table
   * rather than tell them a rule they no longer have to follow.
   */
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
  'nothingToCatch',
  'notEnoughPlayers',
  'tooManyPlayers',
  'duplicatePlayerId',
  /** Asked to skip a seat that is not the one the table is waiting for. */
  'nothingToSkip',
  /** Asked to act for, or remove, a player who has already left. */
  'alreadyLeft',
  /** The table is holding at somebody's request. */
  'tablePaused',
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
