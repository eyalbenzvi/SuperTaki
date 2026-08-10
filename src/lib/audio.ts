/**
 * The table's voice, synthesised.
 *
 * **No audio file, and that is forced rather than chosen.** The page declares no
 * `media-src`, so `default-src 'self'` applies to media and even a `data:` URI in
 * an `<audio>` element is blocked. WebAudio performs no fetch at all and is
 * outside the policy's scope entirely — so the constraint that looks like an
 * obstacle picks the right answer. It is also far smaller: six forty-millisecond
 * WAVs base64-encoded are several kilobytes that barely compress, against a couple
 * for every cue here.
 *
 * Peak gain is deliberately low. A card game that is loud is a card game that gets
 * muted after two rounds and never unmuted.
 */

/** Every sound the table can make. Seven, out of twenty-five possible events. */
export type Cue = 'play' | 'draw' | 'yourTurn' | 'penalty' | 'lastCard' | 'caught' | 'win';

/** Nothing is ever louder than this. */
export const PEAK_GAIN = 0.25;

type Ctor = new () => AudioContext;

function contextCtor(): Ctor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const scope = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

interface Voice {
  readonly type: OscillatorType;
  /** Frequencies in order; more than one is an arpeggio. */
  readonly notes: readonly number[];
  readonly durationMs: number;
  readonly gain: number;
  /** Band-passed noise instead of a tone — how a card sounds hitting a table. */
  readonly noise?: boolean;
  readonly filterHz?: number;
}

/*
 * What each cue is. Notably absent: an opponent drawing a card, which happens
 * several times a minute and would become wallpaper; anything at all on a UI tap;
 * and any sound for an illegal card, because a buzzer for a mistap is punishment
 * for a UI we designed.
 */
const VOICES: Record<Cue, Voice> = {
  play: { type: 'triangle', notes: [900], durationMs: 70, gain: 1, noise: true, filterHz: 900 },
  draw: { type: 'triangle', notes: [760], durationMs: 45, gain: 0.7, noise: true, filterHz: 760 },
  yourTurn: { type: 'triangle', notes: [660, 880], durationMs: 90, gain: 0.8 },
  penalty: { type: 'square', notes: [440, 350, 260], durationMs: 220, gain: 0.55 },
  lastCard: { type: 'sine', notes: [1320], durationMs: 120, gain: 0.7 },
  caught: { type: 'square', notes: [520, 300], durationMs: 180, gain: 0.6 },
  win: { type: 'triangle', notes: [523, 659, 784, 1047], durationMs: 600, gain: 0.8 },
};

let context: AudioContext | null = null;
let enabled = true;

/** Turns the table's voice on or off. Persisted by the caller. */
export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Wakes the audio context, from inside a real gesture.
 *
 * Called on Start or Join, never on the first card tap: `resume()` is asynchronous,
 * so a context woken by the tap that should have made a sound swallows or delays
 * its own first cue.
 *
 * `navigator.audioSession` is deliberately left alone. iOS honours the hardware
 * mute switch for WebAudio, and overriding it would mean a player who silenced
 * their phone hears a card game anyway. They meant it.
 */
export function unlockSound(): void {
  const Ctor = contextCtor();
  if (!Ctor) {
    return;
  }
  try {
    context ??= new Ctor();
    if (context.state === 'suspended') {
      void context.resume();
    }
  } catch {
    context = null;
  }
}

/** Lets go of the audio device, e.g. when the table closes. */
export function releaseSound(): void {
  const current = context;
  context = null;
  if (!current) {
    return;
  }
  try {
    void current.close();
  } catch {
    /* Already closed. */
  }
}

function noiseBuffer(ctx: AudioContext, durationMs: number): AudioBuffer {
  const frames = Math.max(1, Math.floor((ctx.sampleRate * durationMs) / 1000));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frames; index += 1) {
    // Deterministic rather than random: the same cue should sound the same, and
    // this is a texture, not a signal anybody decodes.
    data[index] = Math.sin(index * 12.9898) * Math.exp((-4 * index) / frames);
  }
  return buffer;
}

/**
 * Makes one sound, or does nothing whatsoever.
 *
 * Every failure path is a silent no-op: no context, no support, sound switched
 * off, a browser that throws. Audio is decoration, and decoration that can break
 * a turn is worse than no audio.
 */
export function playCue(cue: Cue, options: { volume?: number } = {}): void {
  if (!enabled || !context || context.state !== 'running') {
    return;
  }
  const voice = VOICES[cue];
  const ctx = context;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    const peak = PEAK_GAIN * voice.gain * (options.volume ?? 1);
    master.connect(ctx.destination);
    master.gain.setValueAtTime(0.0001, now);

    if (voice.noise) {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(ctx, voice.durationMs);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = voice.filterHz ?? 900;
      filter.Q.value = 1.2;
      source.connect(filter);
      filter.connect(master);
      master.gain.exponentialRampToValueAtTime(peak, now + 0.006);
      master.gain.exponentialRampToValueAtTime(0.0001, now + voice.durationMs / 1000);
      source.start(now);
      source.stop(now + voice.durationMs / 1000);
      return;
    }

    const step = voice.durationMs / 1000 / voice.notes.length;
    voice.notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const shape = ctx.createGain();
      oscillator.type = voice.type;
      oscillator.frequency.value = frequency;
      oscillator.connect(shape);
      shape.connect(master);
      const start = now + index * step;
      shape.gain.setValueAtTime(0.0001, start);
      shape.gain.exponentialRampToValueAtTime(1, start + 0.008);
      shape.gain.exponentialRampToValueAtTime(0.0001, start + step);
      oscillator.start(start);
      oscillator.stop(start + step);
    });
    master.gain.setValueAtTime(peak, now);
  } catch {
    /* A device that refuses to make a sound is not a reason to stop the game. */
  }
}
