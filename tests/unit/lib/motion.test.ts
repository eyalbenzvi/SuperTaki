import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate, canAnimate, cancelAnimations, prefersReducedMotion } from '../../../src/lib/motion.ts';

/**
 * The point of this module is that the absence of the platform is not a failure,
 * so most of what is asserted here is what happens when nothing is available.
 * jsdom implements no Web Animations API, which makes it the exact environment
 * these guards exist for.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as { animate?: unknown }).animate;
});

describe('canAnimate', () => {
  it('is false where the platform has no Web Animations API', () => {
    expect(canAnimate()).toBe(false);
  });

  it('is true once the platform provides one', () => {
    (Element.prototype as { animate?: unknown }).animate = () => ({});
    expect(canAnimate()).toBe(true);
  });
});

describe('animate', () => {
  it('does nothing and reports nothing when the platform cannot animate', () => {
    const element = document.createElement('div');
    expect(animate(element, [{ opacity: 0 }], { duration: 100 })).toBeNull();
  });

  it('does nothing when there is no element to animate', () => {
    (Element.prototype as { animate?: unknown }).animate = () => ({});
    expect(animate(null, [{ opacity: 0 }], { duration: 100 })).toBeNull();
    expect(animate(undefined, [{ opacity: 0 }], { duration: 100 })).toBeNull();
  });

  it('passes the keyframes straight through when it can', () => {
    const calls: unknown[][] = [];
    (Element.prototype as { animate?: unknown }).animate = function (...args: unknown[]) {
      calls.push(args);
      return { id: 'animation' };
    };
    const element = document.createElement('div');
    const frames = [{ opacity: 0 }, { opacity: 1 }];
    const options = { duration: 240, easing: 'ease-out' };

    expect(animate(element, frames, options)).toEqual({ id: 'animation' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(frames);
    expect(calls[0]?.[1]).toBe(options);
  });

  it('swallows a platform that throws, leaving a correct screen without motion', () => {
    (Element.prototype as { animate?: unknown }).animate = () => {
      throw new Error('bad keyframe');
    };
    const element = document.createElement('div');
    expect(animate(element, [{ opacity: 0 }], { duration: 100 })).toBeNull();
  });
});

describe('cancelAnimations', () => {
  it('detaches the callbacks before cancelling, so nothing observes the abort', () => {
    let cancelled = false;
    const animation = {
      onfinish: (): void => {
        throw new Error('finish must not fire');
      },
      oncancel: (): void => {
        throw new Error('cancel must not fire');
      },
      cancel: (): void => {
        cancelled = true;
      },
    };

    cancelAnimations([animation as unknown as Animation]);

    expect(cancelled).toBe(true);
    expect(animation.onfinish).toBeNull();
    expect(animation.oncancel).toBeNull();
  });

  it('ignores nulls, so a caller need not filter its own list', () => {
    expect(() => {
      cancelAnimations([null, undefined]);
    }).not.toThrow();
  });

  it('survives an animation that is already gone', () => {
    const animation = {
      onfinish: null,
      oncancel: null,
      cancel: (): never => {
        throw new Error('detached');
      },
    };
    expect(() => {
      cancelAnimations([animation as unknown as Animation]);
    }).not.toThrow();
  });
});

describe('prefersReducedMotion', () => {
  it('is false when the query does not match', () => {
    // The suite's setup stubs matchMedia to `matches: false`.
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is true when the player has asked for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it('reads the reduce query specifically', () => {
    const queries: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => {
      queries.push(query);
      return { matches: false, media: query };
    });
    prefersReducedMotion();
    expect(queries).toEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('is false rather than fatal where matchMedia is missing or throws', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);

    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported query');
    });
    expect(prefersReducedMotion()).toBe(false);
  });
});
