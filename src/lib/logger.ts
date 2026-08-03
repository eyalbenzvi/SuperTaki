/**
 * Development-only logging.
 *
 * Enabled automatically in `vite dev`, or in any build via `?debug=1`
 * (the flag is sticky for the tab through `sessionStorage`). Production builds
 * log nothing unless a user explicitly opts in while troubleshooting.
 */

const SESSION_FLAG = 'superTaki:debug';

function readFlag(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('debug');
    if (requested === '1' || requested === 'true') {
      window.sessionStorage.setItem(SESSION_FLAG, '1');
      return true;
    }
    if (requested === '0' || requested === 'false') {
      window.sessionStorage.removeItem(SESSION_FLAG);
      return false;
    }
    return window.sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

let enabled = (import.meta.env?.DEV ?? false) || readFlag();

export function isLoggingEnabled(): boolean {
  return enabled;
}

/** Test/diagnostic hook; not wired to any UI control. */
export function setLoggingEnabled(value: boolean): void {
  enabled = value;
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const tag = `[super-taki:${scope}]`;
  return {
    debug(message, ...details) {
      if (enabled) {
        console.debug(tag, message, ...details);
      }
    },
    warn(message, ...details) {
      if (enabled) {
        console.warn(tag, message, ...details);
      }
    },
    error(message, ...details) {
      // Errors are always surfaced: they indicate a real problem worth reporting.
      console.error(tag, message, ...details);
    },
  };
}
