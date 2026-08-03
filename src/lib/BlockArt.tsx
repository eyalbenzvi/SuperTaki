import type { ReactNode } from 'react';
import { buildSolids, type Part, type SolidOptions } from './blockGeometry.ts';

/**
 * Renders a block drawing: the walls of each part, back to front, then its
 * front face over them.
 *
 * All the geometry lives in `blockGeometry`; this only turns the paths it hands back
 * into elements. `prefix` names the classes, so the cards and the wordmark can
 * be styled apart while sharing every line of the drawing code.
 */
export interface BlockArtProps extends SolidOptions {
  readonly parts: readonly Part[];
  readonly prefix?: string;
}

export function BlockArt({ parts, prefix = 'glyph', ...options }: BlockArtProps): ReactNode {
  return (
    <>
      {buildSolids(parts, options).map((solid, index) => (
        <g key={index} className={solid.slot === undefined ? undefined : `${prefix}__slot--${solid.slot}`}>
          {solid.walls.map((wall, wallIndex) => (
            <path
              key={wallIndex}
              className={`${prefix}__wall ${prefix}__wall--${wall.deep ? 'deep' : 'mid'}`}
              d={wall.d}
            />
          ))}
          <path className={`${prefix}__face`} fillRule="evenodd" d={solid.face} />
        </g>
      ))}
    </>
  );
}
