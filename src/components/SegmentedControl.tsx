import type { ReactNode } from 'react';

export interface SegmentedOption<TValue extends string | number> {
  readonly value: TValue;
  readonly label: string;
  /** Optional longer description for assistive technology. */
  readonly ariaLabel?: string;
}

export interface SegmentedControlProps<TValue extends string | number> {
  readonly label: string;
  readonly value: TValue;
  readonly options: readonly SegmentedOption<TValue>[];
  readonly onChange: (value: TValue) => void;
  readonly disabled?: boolean;
  /** Stretches the options to fill the row; used inside forms. */
  readonly block?: boolean;
}

/** Which way along the list a horizontal arrow key moves, per writing direction. */
function horizontalStep(key: string): number {
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const forwards = rtl ? 'ArrowLeft' : 'ArrowRight';
  return key === forwards ? 1 : -1;
}

/**
 * A small radio group styled as a segmented control.
 *
 * Real radio semantics, a roving tab stop, and the full arrow-key contract:
 * Left/Right follow the writing direction, so the highlight moves the way the
 * key points in Hebrew too; Up/Down follow list order; Home/End jump to the
 * ends.
 */
export function SegmentedControl<TValue extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  block = false,
}: SegmentedControlProps<TValue>): ReactNode {
  const move = (step: number): void => {
    const index = options.findIndex((candidate) => candidate.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (next) {
      onChange(next.value);
    }
  };

  const jump = (index: number): void => {
    const target = options[index];
    if (target) {
      onChange(target.value);
    }
  };

  return (
    <div className={`segmented${block ? ' segmented--block' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel ?? option.label}
            className="segmented__option"
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              onChange(option.value);
            }}
            onKeyDown={(event) => {
              switch (event.key) {
                case 'ArrowRight':
                case 'ArrowLeft':
                  event.preventDefault();
                  move(horizontalStep(event.key));
                  return;
                case 'ArrowDown':
                  event.preventDefault();
                  move(1);
                  return;
                case 'ArrowUp':
                  event.preventDefault();
                  move(-1);
                  return;
                case 'Home':
                  event.preventDefault();
                  jump(0);
                  return;
                case 'End':
                  event.preventDefault();
                  jump(options.length - 1);
                  return;
                default:
                  return;
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
