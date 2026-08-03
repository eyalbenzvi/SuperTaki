import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * Traps Tab focus inside `containerRef` while `active`, moves focus in on open,
 * restores it to the previously focused element on close, and calls `onEscape`
 * for the Escape key.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initial = focusableWithin(container)[0] ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const current = document.activeElement;

      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef, onEscape]);
}
