import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PEAK_GAIN,
  playCue,
  releaseSound,
  setSoundEnabled,
  unlockSound,
  type Cue,
} from '../../../src/lib/audio.ts';

/**
 * Audio is decoration, so most of what matters here is what happens when it is
 * unavailable, refused or switched off. jsdom implements no `AudioContext`, which
 * makes it the environment every one of those guards exists for.
 */

interface Recorded {
  /**
   * Values set on the node that feeds the output.
   *
   * Only that one bounds loudness: the per-note shapers reach 1 by design and are
   * multiplied by it, so asserting on every gain node in the graph would be
   * asserting the wrong thing.
   */
  readonly output: number[];
  oscillators: number;
  buffers: number;
}

function stubContext(state: AudioContextState = 'running'): {
  readonly recorded: Recorded;
  readonly resumes: () => number;
} {
  const recorded: Recorded = { output: [], oscillators: 0, buffers: 0 };
  let resumes = 0;
  class FakeContext {
    state: AudioContextState = state;
    currentTime = 0;
    sampleRate = 48_000;
    destination = {};
    resume(): Promise<void> {
      resumes += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    createGain(): unknown {
      const values: number[] = [];
      let feedsOutput = false;
      return {
        connect: (target: unknown) => {
          if (target === this.destination) {
            feedsOutput = true;
            recorded.output.push(...values);
          }
        },
        gain: {
          setValueAtTime: (value: number) => {
            values.push(value);
            if (feedsOutput) {
              recorded.output.push(value);
            }
          },
          exponentialRampToValueAtTime: (value: number) => {
            values.push(value);
            if (feedsOutput) {
              recorded.output.push(value);
            }
          },
        },
      };
    }
    createOscillator(): unknown {
      recorded.oscillators += 1;
      return {
        type: 'sine',
        frequency: { value: 0 },
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      };
    }
    createBufferSource(): unknown {
      return { buffer: null, connect: () => undefined, start: () => undefined, stop: () => undefined };
    }
    createBiquadFilter(): unknown {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: () => undefined };
    }
    createBuffer(_channels: number, frames: number): unknown {
      recorded.buffers += 1;
      return { getChannelData: () => new Float32Array(frames) };
    }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  return { recorded, resumes: () => resumes };
}

afterEach(() => {
  releaseSound();
  setSoundEnabled(true);
  vi.unstubAllGlobals();
});

describe('availability', () => {
  it('does nothing at all when there is no audio platform', () => {
    expect(() => {
      unlockSound();
      playCue('play');
    }).not.toThrow();
  });
});

describe('waking the device', () => {
  it('resumes a suspended context once', () => {
    const { resumes } = stubContext('suspended');
    unlockSound();
    unlockSound();
    // One per session: it is woken by the gesture that starts a table, not by
    // every cue, and `resume` is asynchronous enough to swallow its own first one.
    expect(resumes()).toBe(1);
  });

  it('survives a constructor that throws', () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no device');
        }
      },
    );
    expect(() => {
      unlockSound();
    }).not.toThrow();
    expect(() => {
      playCue('win');
    }).not.toThrow();
  });
});

describe('making a sound', () => {
  it('says nothing until the context is awake', () => {
    const { recorded } = stubContext('suspended');
    // Constructed but never resumed: a cue now would be inaudible anyway.
    playCue('play');
    expect(recorded.output).toHaveLength(0);
  });

  it('plays a tone cue as an ordered set of notes', () => {
    const { recorded } = stubContext();
    unlockSound();
    playCue('win');
    // Four notes, so four oscillators: the arpeggio is the cue.
    expect(recorded.oscillators).toBe(4);
  });

  it('plays a card landing as filtered noise, not a tone', () => {
    const { recorded } = stubContext();
    unlockSound();
    playCue('play');
    // How a card actually sounds hitting a table; a sine wave sounds like a phone.
    expect(recorded.buffers).toBe(1);
    expect(recorded.oscillators).toBe(0);
  });

  it('never exceeds the peak gain, for any cue', () => {
    const { recorded } = stubContext();
    unlockSound();
    const cues: Cue[] = ['play', 'draw', 'yourTurn', 'penalty', 'lastCard', 'caught', 'win'];
    for (const cue of cues) {
      playCue(cue);
    }
    // A card game that is loud is a card game that gets muted permanently.
    expect(recorded.output.length).toBeGreaterThan(0);
    for (const gain of recorded.output) {
      expect(gain).toBeLessThanOrEqual(PEAK_GAIN + 1e-9);
    }
  });

  it('is silent when the player has switched sound off', () => {
    const { recorded } = stubContext();
    unlockSound();
    setSoundEnabled(false);
    playCue('win');
    expect(recorded.output).toHaveLength(0);
  });
});
