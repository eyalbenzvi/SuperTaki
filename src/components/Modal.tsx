import { useId, useRef, type ReactNode } from 'react';
import { useFocusTrap } from '../lib/useFocusTrap.ts';
import { Button } from './Button.tsx';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  /** Rendered in the action row; the modal supplies no default buttons. */
  readonly actions?: ReactNode;
  /** Set false for choices the player must make (e.g. picking a wild colour). */
  readonly dismissible?: boolean;
  /** Accessible name for the header's close control; omit for no close button. */
  readonly closeLabel?: string;
  readonly size?: 'sm' | 'md';
}

/**
 * Accessible dialog: labelled, focus-trapped, Escape-closable and
 * focus-restoring. Rendered inline (no portal) — the app has a single root and
 * the backdrop is fixed-position, so stacking works without one.
 *
 * On a phone it is a bottom sheet: anchored to the thumb, never taller than the
 * visible viewport, and clear of the home indicator.
 */
export function Modal({
  open,
  title,
  children,
  onClose,
  actions,
  dismissible = true,
  closeLabel,
  size = 'sm',
}: ModalProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useFocusTrap(containerRef, open, dismissible ? onClose : undefined);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? descriptionId : undefined}
        ref={containerRef}
        tabIndex={-1}
      >
        <div className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          {dismissible && closeLabel ? (
            <Button
              iconOnly
              icon="close"
              variant="ghost"
              size="sm"
              aria-label={closeLabel}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? (
          <div className="modal__content" id={descriptionId}>
            {children}
          </div>
        ) : null}
        {actions ? <div className="modal__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
