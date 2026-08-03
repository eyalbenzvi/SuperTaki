import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMessageId,
  createPlayerId,
  createResumeToken,
  randomHex,
  randomInt,
} from '../../../src/lib/id.ts';
import { createLogger, isLoggingEnabled, setLoggingEnabled } from '../../../src/lib/logger.ts';
import { canShare, copyText, shareLink } from '../../../src/lib/share.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('identifiers', () => {
  it('produces hex of the requested length', () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(0)).toBe('');
  });

  it('produces distinct message ids', () => {
    const ids = new Set(Array.from({ length: 500 }, createMessageId));
    expect(ids.size).toBe(500);
  });

  it('prefixes player ids and sizes resume tokens', () => {
    expect(createPlayerId()).toMatch(/^pl_[0-9a-f]{16}$/);
    expect(createResumeToken()).toHaveLength(32);
  });

  it('bounds random integers and rejects a bad range', () => {
    for (let i = 0; i < 300; i += 1) {
      const value = randomInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(1.5)).toThrow(RangeError);
  });

  it('rejects values above the rejection-sampling limit', () => {
    // Force one out-of-range draw so the retry path is exercised.
    // 0xffffffff is above the rejection limit for modulus 3, so it is redrawn.
    const values = [0xffffffff, 3];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const view = array as Uint32Array;
      view[0] = values.shift() ?? 1;
      return array;
    });
    expect(randomInt(3)).toBe(0);
  });
});

describe('logger', () => {
  it('is silent unless enabled', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = isLoggingEnabled();

    setLoggingEnabled(false);
    const log = createLogger('test');
    log.debug('hidden');
    log.warn('hidden');
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    setLoggingEnabled(true);
    log.debug('shown');
    expect(debug).toHaveBeenCalledWith('[color-rush:test]', 'shown');
    setLoggingEnabled(previous);
  });

  it('always reports errors', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLoggingEnabled(false);
    createLogger('test').error('boom');
    expect(error).toHaveBeenCalled();
  });
});

describe('sharing', () => {
  it('copies through the async clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to a hidden textarea when the clipboard is refused', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    expect(await copyText('hello')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    // The temporary node is always removed again.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure when nothing works', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', {
      value: () => {
        throw new Error('nope');
      },
      configurable: true,
    });
    expect(await copyText('hello')).toBe(false);
  });

  it('detects Web Share support', () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    expect(canShare()).toBe(false);

    vi.stubGlobal('navigator', { ...navigator, share: vi.fn().mockResolvedValue(undefined) });
    expect(canShare()).toBe(true);
  });

  it('shares a link and treats a cancellation as a no-op', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    expect(await shareLink({ title: 't', text: 'x', url: 'https://example.com' })).toBe(true);

    vi.stubGlobal('navigator', {
      ...navigator,
      share: vi.fn().mockRejectedValue(new Error('AbortError')),
    });
    expect(await shareLink({ title: 't', text: 'x', url: 'https://example.com' })).toBe(false);

    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    expect(await shareLink({ title: 't', text: 'x', url: 'https://example.com' })).toBe(false);
  });
});
