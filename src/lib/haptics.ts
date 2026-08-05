/**
 * Two moments, on Android only.
 *
 * **iOS Safari has never implemented the Vibration API**, so this is a bonus for
 * roughly half the players and nothing is designed on the assumption that it
 * exists. Two triggers, deliberately: a penalty arriving, and a turn beginning
 * after the player has looked away. Per-tap vibration is where this feature always
 * goes to die — it drains a battery, it is noticed as noise, and it is the first
 * thing anybody hunts for a setting to switch off.
 */

/** A penalty just landed on me. */
export const PENALTY_PATTERN = 30;
/** My turn, and I was not watching. */
export const RETURN_PATTERN: readonly number[] = [0, 20, 60, 20];

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function buzz(pattern: number | readonly number[]): void {
  if (!canVibrate()) {
    return;
  }
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch {
    /* A device that will not buzz is not a problem worth reporting. */
  }
}

export function penaltyBuzz(): void {
  buzz(PENALTY_PATTERN);
}

export function returnBuzz(): void {
  buzz([...RETURN_PATTERN]);
}
