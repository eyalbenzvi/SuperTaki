import type { ReactNode } from 'react';

/**
 * The icon set.
 *
 * One 24×24 grid, one stroke weight, round joins — drawn inline so an icon
 * costs no request and inherits `currentColor`. Icons are decoration only:
 * every icon-only control carries its own accessible name, so each glyph is
 * `aria-hidden` and never the sole carrier of meaning.
 */

export type IconName =
  | 'settings'
  | 'close'
  | 'copy'
  | 'check'
  | 'share'
  | 'users'
  | 'crown'
  | 'clockwise'
  | 'playOrder'
  | 'leave'
  | 'chevronDown'
  | 'chevronUp'
  | 'log'
  | 'offline'
  | 'alert'
  | 'info'
  | 'remove'
  | 'hourglass'
  | 'trophy'
  | 'link'
  | 'robot';

/** Paths are stroked, not filled, so one weight reads at every size. */
const PATHS: Record<IconName, ReactNode> = {
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  share: (
    <>
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
    </>
  ),
  crown: <path d="M3 18h18l-1.6-9-4.4 4-3-6-3 6-4.4-4L3 18Z" />,
  clockwise: (
    <>
      <path d="M21 12a9 9 0 1 1-3.5-7.14" />
      <path d="M21 3v6h-6" />
    </>
  ),
  /*
   * The play order, drawn as what it is: a straight arrow along a row of seats.
   *
   * It replaced a circular "turning" glyph, which had no circle of seats on screen
   * to turn around — the table is a row — and which could not be mirrored for
   * Hebrew, where the seating order runs the other way. The arrow is drawn pointing
   * right and flipped by the chip when the order runs left.
   */
  playOrder: (
    <>
      <path d="M3 12h14" />
      <path d="m12 6.5 5.5 5.5-5.5 5.5" />
    </>
  ),
  leave: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  log: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  offline: (
    <>
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M2 8.8a15.5 15.5 0 0 1 4.2-2.6" />
      <path d="M17.8 6.2A15.5 15.5 0 0 1 22 8.8" />
      <path d="M5 12.5a10 10 0 0 1 3-1.9" />
      <path d="M16 10.6a10 10 0 0 1 3 1.9" />
      <path d="M12 20h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  remove: (
    <>
      <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M16 11h6" />
    </>
  ),
  hourglass: (
    <>
      <path d="M6 3h12M6 21h12" />
      <path d="M8 3v3.5L12 11l4-4.5V3M8 21v-3.5L12 13l4 4.5V21" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 21h8M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 6H4.5A2.5 2.5 0 0 0 7 9M17 6h2.5A2.5 2.5 0 0 1 17 9" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  // A head with an aerial: the one glyph nobody mistakes for a person.
  robot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 3v5M9 20v1M15 20v1" />
      <path d="M9 13h.01M15 13h.01" />
    </>
  ),
};

export interface IconProps {
  readonly name: IconName;
  /** Sized in `em` so an icon scales with the text beside it. */
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 1.15, className }: IconProps): ReactNode {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      style={{ width: `${size}em`, height: `${size}em` }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
