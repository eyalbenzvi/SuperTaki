import { useState, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { clearDiagnostics, formatDiagnostics, readDiagnostics } from '../lib/diagnostics.ts';
import { useT } from './useT.ts';

/**
 * The local record of connection events, for when somebody says "it just froze".
 *
 * Its real purpose is to make the next decision an informed one. Three causes look
 * identical to a player — the network never made a path, the tab was suspended by
 * the operating system, or the host reloaded — and they call for three completely
 * different fixes. Without this, choosing between them is guesswork.
 *
 * Nothing is transmitted. It lives in this tab and is copied out by hand.
 */
export function DiagnosticsPanel(): ReactNode {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);
  const entries = readDiagnostics();
  void version;

  return (
    <section className="diagnostics">
      <h3>{t('diagnostics.title')}</h3>
      <p className="field__hint">{t('diagnostics.body')}</p>
      {entries.length === 0 ? (
        <p className="field__hint">{t('diagnostics.empty')}</p>
      ) : (
        <pre className="diagnostics__log" aria-label={t('diagnostics.title')}>
          {formatDiagnostics()}
        </pre>
      )}
      <div className="diagnostics__actions">
        <Button
          variant="ghost"
          disabled={entries.length === 0}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(formatDiagnostics())
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                // Clipboard access can be refused; the log is on screen either way.
                setCopied(false);
              });
          }}
        >
          {copied ? t('diagnostics.copied') : t('diagnostics.copy')}
        </Button>
        <Button
          variant="ghost"
          disabled={entries.length === 0}
          onClick={() => {
            clearDiagnostics();
            setVersion((value) => value + 1);
            setCopied(false);
          }}
        >
          {t('diagnostics.clear')}
        </Button>
      </div>
    </section>
  );
}
