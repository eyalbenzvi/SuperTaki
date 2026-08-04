/**
 * Reads a QR code the way a phone does.
 *
 * The encoder in `src/lib/qr.ts` is ours, so the tests around it cannot be ours
 * too: a misreading of the specification would satisfy any assertion we wrote
 * about our own output. jsQR is a dev dependency for this one purpose — it is the
 * independent half of the check, and it is what makes "the lobby shows a QR code
 * that scans to the invite link" a fact rather than a hope.
 */

import jsQR from 'jsqr';
import type { QrMatrix } from '../../src/lib/qr.ts';

/** Pixels per module. Enough for the decoder's sampling, small enough to be quick. */
const SCALE = 6;

/** Modules of light border, as the specification asks and the component draws. */
const QUIET_ZONE = 4;

function decode(dark: (x: number, y: number) => boolean, size: number): string | null {
  const span = size * SCALE;
  const data = new Uint8ClampedArray(span * span * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!dark(x, y)) {
        continue;
      }
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const pixel = ((y * SCALE + dy) * span + x * SCALE + dx) * 4;
          data[pixel] = 0;
          data[pixel + 1] = 0;
          data[pixel + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, span, span)?.data ?? null;
}

/** Scans a matrix straight from the encoder, adding the quiet zone itself. */
export function scanMatrix(matrix: QrMatrix): string | null {
  return decode(
    (x, y) =>
      x >= QUIET_ZONE &&
      y >= QUIET_ZONE &&
      x < matrix.size + QUIET_ZONE &&
      y < matrix.size + QUIET_ZONE &&
      ((matrix.modules[y - QUIET_ZONE] as readonly boolean[])[x - QUIET_ZONE] as boolean),
    matrix.size + QUIET_ZONE * 2,
  );
}

/**
 * Scans what a browser would actually show, from the `<svg>` in the document —
 * the quiet zone, the module path and all.
 */
export function scanSvg(svg: SVGSVGElement): string | null {
  const viewBox = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const span = viewBox[3] as number;
  const path = svg.querySelector('path')?.getAttribute('d') ?? '';
  const dark = new Set<string>();
  for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    dark.add(`${x as string},${y as string}`);
  }
  return decode((x, y) => dark.has(`${String(x)},${String(y)}`), span);
}
