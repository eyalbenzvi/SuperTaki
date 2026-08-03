import { useId, useRef, type ReactNode } from 'react';
import { useFocusTrap } from '../lib/useFocusTrap.ts';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  /** Rendered in the action row; the modal supplies no default buttons. */
  readonly actions?: ReactNode;
  /** Set for choices the player must make (e.g. picking a wild colour). */
  readonly dismissible?: boolean;
}

/**
 * Accessible dialog: labelled, focus-trapped, Escape-closable and
 * focus-restoring. Rendered inline (no portal) — the app has a single root and
 * the backdrop is fixed-position, so stacking works without one.
 */
export function Modal({
  open,
  title,
  children,
  onClose,
  actions,
  dismissible = true,
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
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? descriptionId : undefined}
        ref={containerRef}
        tabIndex={-1}
      >
        <h2 className="modal__title" id={titleId}>
          {title}
        </h2>
        {children ? <div id={descriptionId}>{children}</div> : null}
        {actions ? <div className="modal__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
