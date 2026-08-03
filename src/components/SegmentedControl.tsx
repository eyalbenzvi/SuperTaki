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
}

/**
 * A small radio group styled as a segmented control.
 * Uses real radio semantics so arrow keys and screen readers work.
 */
export function SegmentedControl<TValue extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SegmentedControlProps<TValue>): ReactNode {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
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
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
                return;
              }
              event.preventDefault();
              const index = options.findIndex((candidate) => candidate.value === value);
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = options[(index + step + options.length) % options.length];
              if (next) {
                onChange(next.value);
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
