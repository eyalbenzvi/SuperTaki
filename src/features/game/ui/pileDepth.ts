/**
 * How thick the draw pile looks, in four steps.
 *
 * Bucketed rather than continuous: a stack that thins by a fraction of a pixel
 * per card is a stack nobody can see thinning, and four steps is enough to read
 * "plenty / half / getting low / nearly out" without anybody parsing the count
 * printed underneath it.
 */
export function depthBucket(count: number): 0 | 1 | 2 | 3 {
  if (count > 30) {
    return 3;
  }
  if (count > 15) {
    return 2;
  }
  return count > 5 ? 1 : 0;
}
