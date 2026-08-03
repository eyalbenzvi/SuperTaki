/**
 * Block art: the drawing engine behind the card symbols and the wordmark.
 *
 * Every symbol in the printed Taki deck is a solid object seen from slightly
 * above and to the right — a bright front face, and the side and bottom faces
 * of the same object in darker shades of the same hue, with a black line on
 * *every* edge, including the internal ones where the front face meets a side.
 * Those internal lines are what make the thing read as an object rather than a
 * shape with a shadow behind it.
 *
 * So a symbol here is not a picture, it is a prism: a flat polygon (the front
 * face) plus an extrusion vector. This module takes the polygon and works out
 * the solid:
 *
 *   - for each edge of the outline, decide whether that edge's wall is turned
 *     towards the viewer — it is, if the edge's outward normal points the same
 *     way as the extrusion;
 *   - emit that wall as its own quadrilateral, shaded by which way it faces
 *     (a wall facing left catches more light than one facing down);
 *   - paint the walls back to front, then the front face over the top.
 *
 * Because every wall is a real path, every internal edge is a real stroked
 * line, and the two tones meet crisply instead of blurring into one dark mass.
 *
 * Shapes are authored in whatever coordinates suit them and fitted into the
 * drawing box afterwards. The fit is baked into the point values rather than
 * applied as an SVG transform, so the outline keeps the same weight no matter
 * how big or small the shape was drawn.
 */

export type Pt = readonly [number, number];
export type Ring = readonly Pt[];

/** A closed region: one outline, and any counters punched out of it. */
export interface Shape {
  readonly outer: Ring;
  readonly holes?: readonly Ring[];
}

/**
 * One solid in a drawing. Several parts make up a symbol — the four letters of
 * TAKI, a numeral and the little plus beside it — and each is extruded on its
 * own so the one nearer the viewer overlaps the one behind with a clean edge.
 */
export interface Part {
  readonly shapes: readonly Shape[];
  /** Picks a suit for this part on the multicoloured cards. */
  readonly slot?: number;
  /** Forces stacking order; by default a part's own position decides it. */
  readonly z?: number;
}

/** The extrusion, in drawing-box units: down and to the left. */
export const DEPTH: Pt = [-8.6, 10.4];

/* Geometry ------------------------------------------------------------------ */

/**
 * Points along an elliptical arc, for the bowls of the rounded numerals.
 * Angles are in degrees, measured the way the drawing box runs: 0 is right,
 * 90 is *down*, so an increasing angle turns clockwise on screen.
 */
export function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 8,
): Pt[] {
  const points: Pt[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = ((from + ((to - from) * index) / steps) * Math.PI) / 180;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

function mapShape(shape: Shape, f: (p: Pt) => Pt): Shape {
  return {
    outer: shape.outer.map(f),
    ...(shape.holes ? { holes: shape.holes.map((hole) => hole.map(f)) } : {}),
  };
}

/** Turns a shape half a turn about a point — a 9 is a 6 stood on its head. */
export function turn(shapes: readonly Shape[], cx: number, cy: number): Shape[] {
  return shapes.map((shape) => mapShape(shape, ([x, y]) => [2 * cx - x, 2 * cy - y]));
}

/** Twice the signed area; positive means the ring runs clockwise on screen. */
function signedArea(ring: Ring): number {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, ay] = ring[index]!;
    const [bx, by] = ring[(index + 1) % ring.length]!;
    total += ax * by - bx * ay;
  }
  return total;
}

/**
 * Rewinds a ring so outlines run clockwise and counters run anticlockwise.
 * With that convention the same normal formula points out of the material for
 * both, so a counter's walls are found exactly like an outline's — and shapes
 * can be typed in whichever direction was easiest to think about.
 */
function orient(ring: Ring, clockwise: boolean): Ring {
  return signedArea(ring) >= 0 === clockwise ? ring : [...ring].reverse();
}

function ringsOf(shape: Shape): Ring[] {
  return [orient(shape.outer, true), ...(shape.holes ?? []).map((hole) => orient(hole, false))];
}

/* Fitting -------------------------------------------------------------------- */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(parts: readonly Part[]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number): void => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  for (const part of parts) {
    for (const shape of part.shapes) {
      for (const [x, y] of shape.outer) add(x, y);
    }
  }
  return b;
}

/**
 * Scales and centres a drawing into the box, leaving room for the extrusion so
 * the solid — not just its front face — is what gets centred. Symbols drawn at
 * different sizes therefore end up with the same apparent thickness.
 */
function fit(parts: readonly Part[], box: Box, depth: Pt): Part[] {
  const source = boundsOf(parts);
  const sw = Math.max(source.maxX - source.minX, 0.001);
  const sh = Math.max(source.maxY - source.minY, 0.001);
  const room = { w: Math.max(box.w - Math.abs(depth[0]), 1), h: Math.max(box.h - Math.abs(depth[1]), 1) };
  const s = Math.min(room.w / sw, room.h / sh);
  // Centre the front face inside what is left once the extrusion has taken its
  // slice: the body then sits centred, leaning down-left out of the middle.
  const ox = box.x + (box.w - Math.abs(depth[0]) - sw * s) / 2 + Math.max(0, -depth[0]) - source.minX * s;
  const oy = box.y + (box.h - Math.abs(depth[1]) - sh * s) / 2 + Math.max(0, -depth[1]) - source.minY * s;
  const place = ([x, y]: Pt): Pt => [x * s + ox, y * s + oy];
  return parts.map((part) => ({ ...part, shapes: part.shapes.map((shape) => mapShape(shape, place)) }));
}

/* Solids --------------------------------------------------------------------- */

export interface Wall {
  readonly d: string;
  readonly deep: boolean;
  readonly key: number;
}

function facePath(shapes: readonly Shape[]): string {
  return shapes
    .flatMap(ringsOf)
    .map((ring) => `M${ring.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`)
    .join('');
}

/**
 * The walls of one part, ordered back to front.
 *
 * An edge grows a wall when its outward normal points the way the solid leans.
 * Neighbouring edges that agree — both turned down, or both turned sideways —
 * are welded into one strip rather than emitted one quad at a time: a bowl
 * approximated by sixteen little facets would otherwise show sixteen outlines
 * across its inside and read as hatching instead of a curved wall. What is
 * left is exactly the lines the printed card has: the silhouette, and the one
 * seam where a wall stops facing sideways and starts facing down.
 *
 * Ordering falls out of the projection: because the body runs down-left, a wall
 * further down-left is further from the viewer, so painting in that order
 * resolves every overlap — which is what keeps a notched shape like a plus or a
 * 4 from showing walls through its own front.
 */
function wallsOf(shapes: readonly Shape[], depth: Pt): Wall[] {
  const [ex, ey] = depth;
  const length = Math.hypot(ex, ey);
  const walls: Wall[] = [];

  const emit = (run: Pt[], deep: boolean): void => {
    if (run.length < 2) return;
    const back = [...run].reverse().map(([x, y]): Pt => [x + ex, y + ey]);
    const points = [...run, ...back];
    walls.push({
      d: `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`,
      deep,
      key: run.reduce((sum, [x, y]) => sum + (x * ex + y * ey) / length, 0) / run.length,
    });
  };

  for (const shape of shapes) {
    for (const ring of ringsOf(shape)) {
      // Classify every edge first: is its wall turned towards us, and is it
      // turned more downwards (the tone the light misses) or more sideways?
      const facing = ring.map((_, index) => {
        const [ax, ay] = ring[index]!;
        const [bx, by] = ring[(index + 1) % ring.length]!;
        const [nx, ny] = [by - ay, ax - bx];
        return { shown: nx * ex + ny * ey > 0.4, deep: Math.abs(ny) >= Math.abs(nx) };
      });

      // Start the sweep at an edge that begins a run, so a run spanning the
      // ring's own start and end is not cut in two.
      const start = facing.findIndex(
        (edge, index) =>
          edge.shown &&
          (() => {
            const before = facing[(index - 1 + facing.length) % facing.length]!;
            return !before.shown || before.deep !== edge.deep;
          })(),
      );
      if (start < 0) continue;

      let run: Pt[] = [];
      let deep = false;
      for (let step = 0; step <= facing.length; step += 1) {
        const index = (start + step) % facing.length;
        const edge = facing[index]!;
        const continues = step < facing.length && edge.shown && (run.length === 0 || edge.deep === deep);
        if (continues) {
          if (run.length === 0) {
            run = [ring[index]!];
            deep = edge.deep;
          }
          run.push(ring[(index + 1) % ring.length]!);
        } else {
          emit(run, deep);
          run = [];
          if (step < facing.length && edge.shown) {
            run = [ring[index]!, ring[(index + 1) % ring.length]!];
            deep = edge.deep;
          }
        }
      }
      emit(run, deep);
    }
  }
  return walls.sort((a, b) => b.key - a.key);
}

/* Building ------------------------------------------------------------------- */

export interface SolidOptions {
  /** Where the drawing goes inside the SVG's own coordinates. */
  readonly box: Box;
  /** Front face only — for indices too small for the block to read. */
  readonly flat?: boolean;
  /** How far the solid leans; a shorter lean suits a crowded drawing. */
  readonly depth?: Pt;
}

/** One part of a drawing, reduced to the paths that draw it. */
export interface Solid {
  readonly slot: number | undefined;
  readonly walls: readonly Wall[];
  readonly face: string;
}

/**
 * Lays a drawing out and turns it into paths, furthest part first.
 *
 * Parts are ordered on the same axis the walls are: a part further down-left is
 * further from the viewer, so a letter to the right of another correctly
 * overlaps it, and the little plus beside a numeral sits in front of it.
 */
export function buildSolids(parts: readonly Part[], options: SolidOptions): Solid[] {
  const { box, flat = false, depth = DEPTH } = options;
  const [ex, ey] = depth;
  const length = Math.hypot(ex, ey);
  const placed = fit(parts, box, flat ? [0, 0] : depth);

  return placed
    .map((part) => {
      const points = part.shapes.flatMap((shape) => shape.outer);
      const cx = points.reduce((sum, [x]) => sum + x, 0) / (points.length || 1);
      const cy = points.reduce((sum, [, y]) => sum + y, 0) / (points.length || 1);
      return { part, key: part.z ?? (cx * ex + cy * ey) / length };
    })
    .sort((a, b) => b.key - a.key)
    .map(({ part }) => ({
      slot: part.slot,
      walls: flat ? [] : wallsOf(part.shapes, depth),
      face: facePath(part.shapes),
    }));
}
