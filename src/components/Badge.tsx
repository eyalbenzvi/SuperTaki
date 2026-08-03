import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly icon?: IconName;
  readonly children: ReactNode;
}

/** A small, non-interactive label: host, turn, seat, penalty. */
export function Badge({ tone = 'neutral', icon, children }: BadgeProps): ReactNode {
  return (
    <span className={`badge badge--${tone}`}>
      {icon ? <Icon name={icon} size={1} /> : null}
      {children}
    </span>
  );
}
