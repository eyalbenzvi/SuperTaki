import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type CalloutTone = 'neutral' | 'info' | 'action' | 'success' | 'warning' | 'danger';

const TONE_ICON: Record<CalloutTone, IconName> = {
  neutral: 'info',
  info: 'info',
  action: 'alert',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
};

export interface CalloutProps {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  /** Overrides the tone's default glyph. */
  readonly icon?: IconName;
  readonly role?: 'status' | 'alert';
  /** Emphasised treatment for the one thing the player must deal with now. */
  readonly urgent?: boolean;
  readonly extraClass?: string;
}

/**
 * A message with a tone, an icon and optional actions: the single pattern for
 * every notice, banner and prompt in the app.
 *
 * Tone is carried by an icon and a title as well as by colour, so it survives a
 * player who cannot separate the hues.
 */
export function Callout({
  tone = 'neutral',
  title,
  children,
  actions,
  icon,
  role,
  urgent = false,
  extraClass,
}: CalloutProps): ReactNode {
  const classes = ['callout', `callout--${tone}`, urgent ? 'callout--urgent' : '', extraClass ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...(role ? { role } : {})}>
      <span className="callout__icon" aria-hidden="true">
        <Icon name={icon ?? TONE_ICON[tone]} size={1.3} />
      </span>
      <div className="callout__body">
        {title ? <strong className="callout__title">{title}</strong> : null}
        {children ? <div className="callout__text">{children}</div> : null}
      </div>
      {actions ? <div className="callout__actions">{actions}</div> : null}
    </div>
  );
}
