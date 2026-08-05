import type { AnchorId } from './choreograph.ts';

/** A rectangle in the overlay's own coordinates. */
export interface LocalRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Converts a viewport rectangle into the overlay's coordinates.
 *
 * Subtracting the overlay's own rect, never its parent's: `inset: 0` resolves
 * against the padding box, and the element the overlay sits inside has padding, so
 * using the parent would offset every flight by it.
 *
 * Viewport rectangles are also what makes right-to-left free. A rect is measured
 * in physical pixels from the physical left edge, so a flight between two anchors
 * is described identically in Hebrew and in English, with no mirroring anywhere.
 */
export function toLocal(rect: DOMRectReadOnly, overlay: DOMRectReadOnly): LocalRect {
  return {
    left: rect.left - overlay.left,
    top: rect.top - overlay.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Where a flight's clone should sit, so its centre is on the anchor's centre. */
export function centreOn(target: LocalRect, size: { width: number; height: number }): LocalRect {
  return {
    left: target.left + (target.width - size.width) / 2,
    top: target.top + (target.height - size.height) / 2,
    width: size.width,
    height: size.height,
  };
}

/**
 * Whether an anchor is somewhere a flight can usefully start or end.
 *
 * Two of the surfaces the anchors live on scroll — the hand can scroll vertically
 * and the row of seats horizontally — so a slot or a seat that has been scrolled
 * out resolves to a rectangle outside the overlay entirely. A flight from there
 * appears to come from nowhere, which is worse than no flight at all.
 */
export function isUsable(rect: LocalRect, overlay: DOMRectReadOnly): boolean {
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return right > 0 && bottom > 0 && rect.left < overlay.width && rect.top < overlay.height;
}

/** A registry of the elements motions travel between. */
export class AnchorRegistry {
  private readonly elements = new Map<AnchorId, Element>();

  set(id: AnchorId, element: Element | null): void {
    if (element === null) {
      this.elements.delete(id);
      return;
    }
    this.elements.set(id, element);
  }

  /**
   * The anchor's rectangle, or `null` if it is not on screen.
   *
   * A missing anchor is normal rather than exceptional: a player's own seat never
   * exists, because the seat list holds only opponents, and a card's slot stops
   * existing the moment the card is played. Callers drop the motion.
   */
  rectOf(id: AnchorId): DOMRectReadOnly | null {
    const element = this.elements.get(id);
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  /** The element itself, for the rare caller that needs to copy from it. */
  elementOf(id: AnchorId): Element | null {
    return this.elements.get(id) ?? null;
  }

  clear(): void {
    this.elements.clear();
  }
}
