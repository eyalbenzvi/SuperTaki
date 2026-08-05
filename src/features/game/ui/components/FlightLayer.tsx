import { useEffect, useRef, type ReactNode } from 'react';
import { animate, cancelAnimations, prefersReducedMotion } from '../../../../lib/motion.ts';
import type { Beat } from '../../state/beat.ts';
import { centreOn, isUsable, toLocal, type AnchorRegistry } from '../anchors.ts';
import { choreograph, type Flight } from '../choreograph.ts';

/**
 * The layer that tells the lie.
 *
 * Cards are cloned onto an overlay and flown between anchors while the real table
 * is **already correct**. That asymmetry is the entire safety argument: a clone
 * owns nothing, so a state update arriving mid-flight never has to be rolled back,
 * a rejected move needs no unwinding, and the worst case is a decoration that is
 * briefly out of date. Nothing here is awaited and nothing here can block an input.
 *
 * The clones are real DOM copies of cards that already exist — `cloneNode` of the
 * card on the discard pile, or of the pile's own back — rather than React elements.
 * Two reasons. A copy is pixel-identical for free, including the five extruded
 * symbol groups a card face is built from, which would otherwise all be rebuilt.
 * And it keeps decoration out of React entirely: no state, so no render cascade,
 * and nothing for the compiler's rules to object to.
 *
 * It must be a sibling of the table region, never a child: that region is a size
 * container, which makes it a containing block for absolutely positioned
 * descendants, and it also scrolls.
 */

export interface FlightLayerProps {
  readonly beat: Beat | null;
  readonly localPlayerId: string | null;
  readonly registry: AnchorRegistry;
}

/**
 * Makes a clone unreachable as well as invisible.
 *
 * `aria-hidden` on the layer keeps clones out of the accessibility tree, but a
 * focusable element inside an `aria-hidden` subtree is worse than either: the draw
 * pile's card is a real `<button>`, so cloning it put a phantom tab stop on screen
 * for the length of a flight, announcing nothing. `inert` covers modern browsers
 * wholesale; stripping focusability by hand covers the rest.
 */
function neutralise(clone: HTMLElement): void {
  clone.inert = true;
  for (const node of clone.querySelectorAll<HTMLElement>('button, [tabindex], a, input')) {
    node.removeAttribute('tabindex');
    node.setAttribute('aria-hidden', 'true');
    if (node instanceof HTMLButtonElement) {
      node.disabled = true;
    }
  }
}

/** The node a flight should copy: the card that arrived, or a face-down back. */
function sourceNode(flight: Flight, registry: AnchorRegistry): Element | null {
  if (flight.card !== null) {
    const discard = registry.elementOf('pile:discard');
    const face = discard?.querySelector('.card');
    if (face) {
      return face;
    }
  }
  const pile = registry.elementOf('pile:draw');
  return pile?.querySelector('.card') ?? null;
}

export function FlightLayer({ beat, localPlayerId, registry }: FlightLayerProps): ReactNode {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const running = useRef<Animation[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  const lastPlayed = useRef(0);

  const seq = beat?.seq ?? 0;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !beat) {
      return;
    }

    const reduced = prefersReducedMotion();
    const plan = choreograph(beat, {
      localPlayerId,
      reducedMotion: reduced,
      inFlight: [...inFlight.current],
      lastPlayedSeq: lastPlayed.current,
    });
    lastPlayed.current = beat.seq;

    const overlayRect = overlay.getBoundingClientRect();
    for (const motion of plan) {
      /*
       * A sweep belongs to the row of seats, which draws it itself: it needs the
       * document's direction, and the seats are the surface it crosses.
       */
      if (motion.kind === 'sweep') {
        continue;
      }

      /*
       * A pulse marks the place something happened to — a seat, the pile, my own
       * hand. It is drawn here rather than by each of those surfaces because the
       * alternative is the same ring implemented three times, in three components
       * that would each have to learn about beats.
       */
      if (motion.kind === 'pulse') {
        const rect = registry.rectOf(motion.at);
        if (!rect) {
          continue;
        }
        const at = toLocal(rect, overlayRect);
        if (!isUsable(at, overlayRect)) {
          continue;
        }
        const mark = document.createElement('div');
        mark.className = `flight-layer__pulse flight-layer__pulse--${motion.tone}`;
        mark.inert = true;
        mark.dataset['intensity'] = String(motion.intensity);
        mark.style.left = `${String(at.left)}px`;
        mark.style.top = `${String(at.top)}px`;
        mark.style.width = `${String(at.width)}px`;
        mark.style.height = `${String(at.height)}px`;
        overlay.append(mark);

        const key = motion.key;
        inFlight.current.add(key);
        /*
         * Opacity only when less motion was asked for. `scale` is an independent
         * transform property, so a pulse that breathed would have been exactly the
         * movement the preference exists to remove — reaching the player through
         * the substitute that was supposed to spare them it.
         */
        const beatAnimation = animate(
          mark,
          reduced
            ? [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }]
            : [
                { opacity: 0, scale: '0.96' },
                { opacity: 1, offset: 0.35 },
                { opacity: 0, scale: '1.02' },
              ],
          {
            duration: motion.durationMs,
            delay: motion.delayMs,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            fill: 'backwards',
          },
        );
        const finished = (): void => {
          inFlight.current.delete(key);
          running.current = running.current.filter((candidate) => candidate !== beatAnimation);
          mark.remove();
        };
        if (beatAnimation) {
          beatAnimation.onfinish = finished;
          beatAnimation.oncancel = finished;
          running.current.push(beatAnimation);
        } else {
          finished();
        }
        continue;
      }
      const fromRect = registry.rectOf(motion.from);
      const toRect = registry.rectOf(motion.to);
      // A seat that is mine, or a slot whose card has already gone. Both normal.
      if (!fromRect || !toRect) {
        continue;
      }
      const from = toLocal(fromRect, overlayRect);
      const to = toLocal(toRect, overlayRect);
      // Scrolled out of sight: the hand scrolls vertically and the seats
      // horizontally, and a card flying in from nowhere is worse than none.
      if (!isUsable(from, overlayRect) || !isUsable(to, overlayRect)) {
        continue;
      }
      const source = sourceNode(motion, registry);
      if (!source) {
        continue;
      }

      const landing = centreOn(to, { width: to.width, height: to.height });
      const start = centreOn(from, { width: to.width, height: to.height });
      const clone = document.createElement('div');
      clone.className = 'flight-layer__card';
      neutralise(clone);
      clone.style.left = `${String(landing.left)}px`;
      clone.style.top = `${String(landing.top)}px`;
      clone.style.width = `${String(to.width)}px`;
      clone.append(source.cloneNode(true));
      neutralise(clone);
      overlay.append(clone);

      const key = motion.key;
      inFlight.current.add(key);
      const animation = animate(
        clone,
        [
          {
            transform: `translate(${String(start.left - landing.left)}px, ${String(
              start.top - landing.top,
            )}px) scale(0.55) rotate(-6deg)`,
            opacity: 0.6,
          },
          { opacity: 1, offset: 0.4 },
          { transform: 'none', opacity: 1 },
        ],
        {
          duration: motion.durationMs,
          delay: motion.delayMs,
          easing: 'cubic-bezier(0.22, 0.7, 0.24, 1)',
          fill: 'backwards',
        },
      );

      const done = (): void => {
        inFlight.current.delete(key);
        // Pruned, not just left: a round is a few hundred motions, and holding
        // every finished Animation for the life of the table is a slow leak.
        running.current = running.current.filter((candidate) => candidate !== animation);
        clone.remove();
      };
      if (animation) {
        // `onfinish`/`oncancel`, never `finished`: cancelling rejects that promise
        // with an `AbortError`, and cancelling in flight is the normal case here.
        animation.onfinish = done;
        animation.oncancel = done;
        running.current.push(animation);
      } else {
        // No platform animation, so there is nothing to describe: the real table
        // is already showing the finished state.
        done();
      }
    }
    // One beat is one accepted command, and the plan is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  useEffect(
    () => () => {
      cancelAnimations(running.current);
      running.current = [];
      inFlight.current.clear();
    },
    [],
  );

  return <div className="flight-layer" ref={overlayRef} aria-hidden="true" />;
}
