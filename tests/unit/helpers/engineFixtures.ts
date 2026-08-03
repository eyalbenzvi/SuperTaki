import { cardColor } from '../../../src/features/game/engine/cards.ts';
import { createRng } from '../../../src/features/game/engine/prng.ts';
import type {
  Card,
  CardColor,
  ColoredActionKind,
  NumberValue,
} from '../../../src/features/game/engine/cards.ts';
import type {
  CommandResult,
  EnginePlayer,
  GameEvent,
  GameState,
  PlayerId,
  RejectionCode,
} from '../../../src/features/game/engine/state.ts';

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}#${counter}`;
}

/**
 * Compact card factory for tests.
 * `'red:5'` -> red 5, `'blue:stop'` -> blue Stop, `'colorChange'` / `'superTaki'` -> wild.
 */
export function card(spec: string): Card {
  if (spec === 'colorChange' || spec === 'superTaki') {
    return { id: nextId(spec), kind: spec };
  }
  const [color, rest] = spec.split(':');
  if (!color || !rest) {
    throw new Error(`Invalid card spec: ${spec}`);
  }
  const numeric = Number(rest);
  if (Number.isInteger(numeric)) {
    return {
      id: nextId(spec),
      kind: 'number',
      color: color as CardColor,
      value: numeric as NumberValue,
    };
  }
  return { id: nextId(spec), kind: rest as ColoredActionKind, color: color as CardColor };
}

export function cards(...specs: string[]): Card[] {
  return specs.map(card);
}

export function players(...names: string[]): EnginePlayer[] {
  return names.map((name) => ({ id: `p-${name.toLowerCase()}`, name }));
}

export interface StateOverrides {
  players?: EnginePlayer[];
  hands?: Record<PlayerId, Card[]>;
  drawPile?: Card[];
  discardPile?: Card[];
  activeColor?: CardColor;
  direction?: 1 | -1;
  currentPlayerIndex?: number;
  takiMode?: GameState['takiMode'];
  pendingPlus?: boolean;
  phase?: GameState['phase'];
  winnerId?: PlayerId | null;
  version?: number;
}

/** Builds a fully-specified game state for targeted rule tests. */
export function makeState(overrides: StateOverrides = {}): GameState {
  const list = overrides.players ?? players('Alice', 'Bob');
  const hands: Record<PlayerId, Card[]> = {};
  for (const player of list) {
    hands[player.id] = overrides.hands?.[player.id] ?? cards('red:1');
  }
  const discardPile = overrides.discardPile ?? cards('red:9');
  const top = discardPile[discardPile.length - 1];
  const fallbackColor: CardColor = (top ? cardColor(top) : null) ?? 'red';

  return {
    version: overrides.version ?? 1,
    phase: overrides.phase ?? 'playing',
    players: list,
    hands,
    drawPile: overrides.drawPile ?? cards('green:4', 'green:5', 'green:6'),
    discardPile,
    activeColor: overrides.activeColor ?? fallbackColor,
    direction: overrides.direction ?? 1,
    currentPlayerIndex: overrides.currentPlayerIndex ?? 0,
    takiMode: overrides.takiMode ?? null,
    pendingPlus: overrides.pendingPlus ?? false,
    rng: createRng(12345),
    winnerId: overrides.winnerId ?? null,
    seed: 12345,
  };
}

/** Unwraps a successful command result, failing loudly otherwise. */
export function expectOk(result: CommandResult): { state: GameState; events: readonly GameEvent[] } {
  if (!result.ok) {
    throw new Error(`Expected success but command was rejected: ${result.rejection.code}`);
  }
  return { state: result.state, events: result.events };
}

/** Asserts a command was rejected with the given code. */
export function expectRejected(result: CommandResult, code: RejectionCode): void {
  if (result.ok) {
    throw new Error(`Expected rejection ${code} but command succeeded`);
  }
  if (result.rejection.code !== code) {
    throw new Error(`Expected rejection ${code} but got ${result.rejection.code}`);
  }
}

export function eventTypes(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.type);
}

export function handOf(state: GameState, playerId: PlayerId): Card[] {
  return (state.hands[playerId] ?? []).slice();
}

export function idOf(state: GameState, playerId: PlayerId, spec: string): string {
  const match = (state.hands[playerId] ?? []).find((candidate) => candidate.id.startsWith(`${spec}#`));
  if (!match) {
    throw new Error(`Card ${spec} not in hand of ${playerId}`);
  }
  return match.id;
}
