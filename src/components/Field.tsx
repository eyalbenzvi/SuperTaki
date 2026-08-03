import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  readonly label: string;
  readonly hint?: string;
  /** Shown below the field and announced; also marks the input invalid. */
  readonly error?: string | null;
  readonly inputClass?: string;
}

/**
 * A labelled text input.
 *
 * The point of the component is the wiring: the hint *and* the error are both
 * in `aria-describedby`, so a screen reader reads the requirement and the
 * failure together, and `aria-invalid` is never out of step with the message on
 * screen.
 */
export function Field({ label, hint, error, inputClass, ...input }: FieldProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={inputClass ? `input ${inputClass}` : 'input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
