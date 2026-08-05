/**
 * The one place that touches the animation platform.
 *
 * Everything else in the app asks for motion through here, so no other file has
 * to feature-detect. That matters for two reasons: the test environment
 * implements no Web Animations API at all — `element.animate` is `undefined` in
 * jsdom — and the rule this module enforces is that **motion is never
 * load-bearing**. A caller that gets `null` back has already put the DOM in its
 * correct final state; the animation was only ever going to describe how it got
 * there.
 *
 * No library. Three easing curves and `element.animate` is the whole
 * requirement, and the smallest animation library that could supply it costs
 * about five kilobytes gzipped.
 */

/** True when the platform can animate at all. */
export function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}

/**
 * Runs one animation, or does nothing at all.
 *
 * Returns `null` when the platform cannot animate, which callers must treat as
 * success: the DOM is already correct.
 */
export function animate(
  element: Element | null | undefined,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!element || !canAnimate()) {
    return null;
  }
  try {
    return element.animate(frames, options);
  } catch {
    /*
     * A malformed keyframe throws rather than degrading. Since motion is never
     * load-bearing, swallowing it leaves a correct screen with no animation,
     * which is strictly better than an exception on the render path.
     */
    return null;
  }
}

/**
 * Stops animations without letting their promises reject.
 *
 * `cancel()` rejects `finished` with an `AbortError`, and cancelling in flight is
 * the normal case here rather than the exceptional one — a player who plays three
 * cards quickly cancels two. Anything awaiting `finished` would produce an
 * unhandled rejection in a browser while being invisible in jsdom, where there is
 * nothing to cancel. So nothing awaits it: callers use `onfinish`/`oncancel`, and
 * this helper detaches both before cancelling.
 */
export function cancelAnimations(animations: Iterable<Animation | null | undefined>): void {
  for (const animation of animations) {
    if (!animation) {
      continue;
    }
    animation.onfinish = null;
    animation.oncancel = null;
    try {
      animation.cancel();
    } catch {
      /* Already finished or detached; there is nothing to stop. */
    }
  }
}

/**
 * Whether the player has asked for less motion.
 *
 * Read here rather than inside the planner: a planner that reads a global is
 * impure, cannot be tested without stubbing the global, and — because it is
 * called while rendering — trips `react-hooks/purity`. The flag is passed in as
 * data instead.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
