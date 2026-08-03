import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Fills the width of its container — the default for a primary action on a phone. */
  readonly block?: boolean;
  readonly icon?: IconName;
  /**
   * Shows a spinner, marks the button busy and blocks further presses. Used for
   * anything that has to wait on the network, so one tap cannot become two.
   */
  readonly busy?: boolean;
  readonly extraClass?: string;
}

interface LabelledProps extends BaseProps {
  readonly children: ReactNode;
  readonly iconOnly?: false;
}

/** An icon-only button has no text, so the accessible name is mandatory. */
interface IconOnlyProps extends BaseProps {
  readonly iconOnly: true;
  readonly icon: IconName;
  readonly 'aria-label': string;
  readonly children?: never;
}

export type ButtonProps = LabelledProps | IconOnlyProps;

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn--primary',
  secondary: '',
  ghost: 'btn--ghost',
  danger: 'btn--danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'btn--sm',
  md: '',
  lg: 'btn--lg',
};

/**
 * The one button in the app.
 *
 * Every action goes through it, so tap-target size, press feedback, focus
 * treatment, the busy state and the disabled state are decided once. There is
 * exactly one primary action per screen region; everything else is secondary,
 * ghost or danger.
 */
export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'secondary',
    size = 'md',
    block = false,
    icon,
    iconOnly = false,
    busy = false,
    extraClass,
    disabled,
    type = 'button',
    children,
    ...rest
  }: BaseProps & { children?: ReactNode; iconOnly?: boolean } = props;

  const classes = [
    'btn',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    block ? 'btn--block' : '',
    iconOnly ? 'btn--icon' : '',
    busy ? 'btn--busy' : '',
    extraClass ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {iconOnly ? null : <span className="btn__label">{children}</span>}
    </button>
  );
}
