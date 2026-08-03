/**
 * Tiny deterministic PRNG (mulberry32) plus a Fisher-Yates shuffle.
 *
 * The engine never calls `Math.random()`. All randomness flows through a
 * serialisable {@link RngState} that is part of the game state, so the host can
 * hand a client the same state and get identical results.
 */

export interface RngState {
  /** 32-bit unsigned counter. */
  readonly seed: number;
}

const UINT32 = 0x100000000;

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0 };
}

/** Derives a numeric seed from an arbitrary string (FNV-1a). */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Returns the next float in [0, 1) and the advanced state. */
export function nextFloat(state: RngState): { value: number; state: RngState } {
  let t = (state.seed + 0x6d2b79f5) >>> 0;
  const nextState: RngState = { seed: t };
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / UINT32;
  return { value, state: nextState };
}

/** Returns an integer in [0, maxExclusive) and the advanced state. */
export function nextInt(state: RngState, maxExclusive: number): { value: number; state: RngState } {
  if (maxExclusive <= 0) {
    throw new RangeError('maxExclusive must be greater than 0');
  }
  const { value, state: nextState } = nextFloat(state);
  return { value: Math.floor(value * maxExclusive), state: nextState };
}

/**
 * Shuffles a copy of `items` using the supplied RNG state.
 * Pure: the input array is never mutated.
 */
export function shuffle<T>(items: readonly T[], state: RngState): { items: T[]; state: RngState } {
  const result = items.slice();
  let rng = state;
  for (let i = result.length - 1; i > 0; i -= 1) {
    const drawn = nextInt(rng, i + 1);
    rng = drawn.state;
    const j = drawn.value;
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return { items: result, state: rng };
}
