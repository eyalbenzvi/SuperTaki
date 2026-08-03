import type { ReactNode } from 'react';
import { useT } from './useT.ts';

/**
 * The Super Taki wordmark: TAKI set two letters over two as chunky extruded
 * blocks, one suit colour each, under a small SUPER. Same drawing treatment as
 * the card symbols, so the mark and the deck look like one thing.
 *
 * Pure CSS and text, so it stays crisp at any size, follows the theme, and
 * works in both writing directions. The visible letters are decorative; the
 * accessible name is the plain title.
 */
export function BrandMark({ size = 'md' }: { readonly size?: 'sm' | 'md' }): ReactNode {
  const t = useT();
  const letters = [...t('app.titleMain')].slice(0, 4);

  return (
    <span className={`brand brand--${size}`} role="img" aria-label={t('app.title')}>
      <span className="brand__super" aria-hidden="true">
        {t('app.titleSuper')}
      </span>
      <span className="brand__word" aria-hidden="true">
        {letters.map((letter, index) => (
          <span className="brand__tile" key={`${letter}-${index}`} data-slot={index}>
            {letter}
          </span>
        ))}
      </span>
    </span>
  );
}
