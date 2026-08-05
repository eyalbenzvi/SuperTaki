import { afterEach, describe, expect, it, vi } from 'vitest';
import { PENALTY_PATTERN, RETURN_PATTERN, penaltyBuzz, returnBuzz } from '../../../src/lib/haptics.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('haptics', () => {
  it('does nothing where the platform has no Vibration API', () => {
    /*
     * Which is every iPhone: iOS Safari has never implemented it. So this is a
     * bonus for roughly half the players and nothing is designed assuming it.
     */
    expect('vibrate' in navigator).toBe(false);
    expect(() => {
      penaltyBuzz();
      returnBuzz();
    }).not.toThrow();
  });

  it('buzzes once for a penalty and a pattern for a turn come back to', () => {
    const calls: (number | number[])[] = [];
    vi.stubGlobal('navigator', {
      vibrate: (pattern: number | number[]) => {
        calls.push(pattern);
        return true;
      },
    });

    penaltyBuzz();
    returnBuzz();

    expect(calls).toEqual([PENALTY_PATTERN, [...RETURN_PATTERN]]);
  });

  it('survives a platform that refuses', () => {
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('denied');
      },
    });
    expect(() => {
      penaltyBuzz();
    }).not.toThrow();
  });

  it('has exactly two triggers, and no more', () => {
    // Per-tap vibration is where this feature always goes to die: it drains a
    // battery, reads as noise, and is the first thing anybody switches off.
    const calls: unknown[] = [];
    vi.stubGlobal('navigator', {
      vibrate: (pattern: unknown) => {
        calls.push(pattern);
        return true;
      },
    });
    penaltyBuzz();
    returnBuzz();
    expect(calls).toHaveLength(2);
  });
});
