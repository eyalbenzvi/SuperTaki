import type { ReactNode } from 'react';
import { BlockArt } from '../lib/BlockArt.tsx';
import type { Part } from '../lib/blockGeometry.ts';
import { letter, setAt, widthAt } from '../lib/blockAlphabet.ts';
import { useT } from './useT.ts';

/**
 * The Super Taki wordmark: SUPER small and black over the left shoulder of
 * TAKI, whose letters are solid blocks in the four suit colours.
 *
 * Drawn by the same engine as the card symbols, from the same alphabet, so the
 * mark and the deck are unmistakably the same object — bright faces, two tones
 * of wall, a line on every edge. The letters sit on one baseline and overlap
 * slightly; because a letter further right is nearer the viewer under this
 * projection, each one correctly laps over the one before it.
 *
 * Drawn rather than set in CSS so the blocks keep their proportions at every
 * size and in both writing directions; the accessible name is the plain title.
 */

/**
 * Cap height, and the space between letters — negative, so each letter's wall
 * lands on the face of the one before it. The mark is a heap of blocks pushed
 * together, not a line of type.
 */
const CAP = 76;
const TRACK = -5;
const SUITS = [2, 0, 1, 3] as const;

export function BrandMark({ size = 'md' }: { readonly size?: 'sm' | 'md' }): ReactNode {
  const t = useT();
  const characters = [...t('app.titleMain')].slice(0, SUITS.length);

  let cursor = 0;
  const parts: Part[] = characters.map((character, index) => {
    const shapes = letter(character);
    const w = widthAt(shapes, CAP);
    const part: Part = {
      shapes: setAt(shapes, cursor + w / 2, CAP / 2, CAP),
      slot: SUITS[index] ?? 0,
    };
    cursor += w + TRACK;
    return part;
  });

  return (
    <svg className={`brand brand--${size}`} viewBox="0 0 208 132" role="img" aria-label={t('app.title')}>
      <text className="brand__super" x="10" y="28" fontSize="28" fontWeight="800" fontFamily="inherit">
        {t('app.titleSuper')}
      </text>
      <BlockArt parts={parts} box={{ x: 4, y: 30, w: 200, h: 98 }} depth={[-14, 17.5]} prefix="brand" />
    </svg>
  );
}
