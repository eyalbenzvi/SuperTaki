import type { ReactNode } from 'react';
import { useT } from './useT.ts';

/**
 * The Super Taki wordmark: SUPER small and black above the left shoulder of
 * TAKI, whose four letters are solid blocks — one suit colour each, outlined,
 * extruded down and to the left.
 *
 * Built the same way as the card symbols: the word is stamped repeatedly along
 * the extrusion vector and the bright faces are drawn on top, so the mark and
 * the deck are unmistakably the same object. Drawn rather than set in CSS so
 * the blocks keep their proportions at every size and in both writing
 * directions; the accessible name is the plain title.
 */
const DEPTH_STEPS = 10;
const STEP_X = -0.95;
const STEP_Y = 1.4;

/* Letter centres, spaced by their own widths so the blocks touch but do not
   swallow each other. The narrow I sits closer than the rest. */
const LETTER_X = [32, 79, 129, 165] as const;

export function BrandMark({ size = 'md' }: { readonly size?: 'sm' | 'md' }): ReactNode {
  const t = useT();
  const letters = [...t('app.titleMain')].slice(0, LETTER_X.length);
  const depth = Array.from({ length: DEPTH_STEPS }, (_, index) => DEPTH_STEPS - index);

  const word = (
    <>
      {letters.map((letter, index) => (
        <text
          key={`${letter}-${index}`}
          className={`brand__letter brand__letter--${index}`}
          x={LETTER_X[index]}
          y={100}
          textAnchor="middle"
          fontSize="70"
          fontWeight="900"
          fontFamily="inherit"
        >
          {letter}
        </text>
      ))}
    </>
  );

  return (
    <svg className={`brand brand--${size}`} viewBox="0 0 178 118" role="img" aria-label={t('app.title')}>
      <text className="brand__super" x="9" y="26" fontSize="24" fontWeight="800" fontFamily="inherit">
        {t('app.titleSuper')}
      </text>
      {depth.map((step) => (
        <g
          key={step}
          className="brand__depth"
          transform={`translate(${(step * STEP_X).toFixed(2)} ${(step * STEP_Y).toFixed(2)})`}
        >
          {word}
        </g>
      ))}
      <g className="brand__face">{word}</g>
    </svg>
  );
}
