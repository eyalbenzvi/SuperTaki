import { useMemo, type ReactNode } from 'react';
import { encodeQr } from '../lib/qr.ts';

/**
 * The light border a scanner needs around the symbol. Four modules is what the
 * specification asks for, and it is part of the drawing rather than CSS padding
 * so no layout change can quietly take it away.
 */
const QUIET_ZONE = 4;

export interface QrCodeProps {
  /** What a scan should produce — for us, the invite link. */
  readonly value: string;
  /** Announced to screen readers, which cannot scan a picture. */
  readonly label: string;
  /** Optional line under the symbol, saying what to do with it. */
  readonly caption?: string;
}

/**
 * Draws `value` as a QR code — or renders nothing at all, caption included, when
 * the value is longer than the encoder can fit. Every caller shows the link
 * beside it, so there is nothing to apologise for in that case, and an empty
 * white plate would be worse than no plate.
 *
 * The symbol is dark-on-white in both themes. A QR code is read by contrast and
 * scanners expect that polarity, so the plate stays white even in the dark theme
 * — inverting it is the kind of taste that stops phones from scanning it.
 */
export function QrCode({ value, label, caption }: QrCodeProps): ReactNode {
  const matrix = useMemo(() => encodeQr(value), [value]);
  if (!matrix) {
    return null;
  }

  const span = matrix.size + QUIET_ZONE * 2;
  // One path for the whole symbol: a rect per module is thousands of nodes.
  let path = '';
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        path += `M${String(x + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h1v1h-1z`;
      }
    });
  });

  return (
    <figure className="qr-figure">
      <span className="qr-figure__plate">
        <svg
          className="qr"
          viewBox={`0 0 ${String(span)} ${String(span)}`}
          role="img"
          aria-label={label}
          /* Modules are whole units in this coordinate system; keep their edges hard. */
          shapeRendering="crispEdges"
        >
          <rect width={span} height={span} fill="#ffffff" />
          <path d={path} fill="#12141c" />
        </svg>
      </span>
      {caption ? <figcaption className="qr-figure__caption">{caption}</figcaption> : null}
    </figure>
  );
}
