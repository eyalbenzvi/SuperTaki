import { describe, expect, it } from 'vitest';
import { encodeQr, type QrMatrix } from '../../../src/lib/qr.ts';
import { scanMatrix } from '../../helpers/qrScan.ts';

/*
 * The encoder is ours, so the test that matters is the one a phone runs: draw the
 * symbol and read it back with a decoder that shares none of our code. See
 * `tests/helpers/qrScan.ts` for what does the reading.
 */

function scan(text: string): string | null {
  const matrix = encodeQr(text);
  return matrix ? scanMatrix(matrix) : null;
}

function versionOf(matrix: QrMatrix): number {
  return (matrix.size - 17) / 4;
}

describe('qr encoding', () => {
  it.each([
    ['a single character', 'A'],
    ['a room code', '482913'],
    ['an invite link', 'https://example.github.io/color-rush/#/join?room=482913'],
    ['an invite link with a host override', 'https://a.github.io/b/#/join?room=482913&host=crush-482913-h1'],
    [
      'a link carrying the transport override',
      'http://localhost:5173/?transport=broadcast#/join?room=000001',
    ],
    ['characters outside ASCII', 'חדר 482913 — נתראה'],
  ])('round trips %s through a decoder', (_label, text) => {
    expect(scan(text)).toBe(text);
  });

  it('reads back at every version it can build', () => {
    // One payload per version, sized to the byte capacity of level M.
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    capacities.forEach((capacity, index) => {
      const text = 'x'.repeat(capacity);
      const matrix = encodeQr(text) as QrMatrix;
      expect(versionOf(matrix), `version for ${String(capacity)} bytes`).toBe(index + 1);
      expect(scan(text)).toBe(text);
    });
  });

  it('takes the smallest symbol that fits, and grows one version at a time', () => {
    expect(versionOf(encodeQr('x'.repeat(14)) as QrMatrix)).toBe(1);
    expect(versionOf(encodeQr('x'.repeat(15)) as QrMatrix)).toBe(2);
    expect(versionOf(encodeQr('x'.repeat(26)) as QrMatrix)).toBe(2);
    expect(versionOf(encodeQr('x'.repeat(27)) as QrMatrix)).toBe(3);
  });

  it('counts UTF-8 bytes rather than characters', () => {
    // Eight Hebrew characters are sixteen bytes, which version 1 cannot hold.
    expect(versionOf(encodeQr('שלוםשלום') as QrMatrix)).toBe(2);
  });

  it('gives up rather than truncating what it cannot fit', () => {
    expect(encodeQr('x'.repeat(213))).not.toBeNull();
    expect(encodeQr('x'.repeat(214))).toBeNull();
  });

  it('is a square grid of the right size', () => {
    const matrix = encodeQr('482913') as QrMatrix;
    expect(matrix.size).toBe(21);
    expect(matrix.modules).toHaveLength(21);
    for (const row of matrix.modules) {
      expect(row).toHaveLength(21);
    }
  });

  it('places the three finder patterns and the timing lines', () => {
    const matrix = encodeQr('https://example.github.io/color-rush/#/join?room=482913') as QrMatrix;
    const dark = (x: number, y: number): boolean => (matrix.modules[y] as readonly boolean[])[x] as boolean;
    const corners: [number, number][] = [
      [3, 3],
      [matrix.size - 4, 3],
      [3, matrix.size - 4],
    ];
    for (const [cx, cy] of corners) {
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          expect(dark(cx + dx, cy + dy), `finder at ${String(cx)},${String(cy)}`).toBe(ring !== 2);
        }
      }
    }
    // The alternating lines that let a scanner find the module grid.
    for (let i = 8; i < matrix.size - 8; i += 1) {
      expect(dark(i, 6), `timing row at ${String(i)}`).toBe(i % 2 === 0);
      expect(dark(6, i), `timing column at ${String(i)}`).toBe(i % 2 === 0);
    }
  });

  it('does not depend on the previous call', () => {
    const first = encodeQr('482913') as QrMatrix;
    const second = encodeQr('482913') as QrMatrix;
    expect(second.modules).toEqual(first.modules);
  });
});
