import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '../lib/logger.ts';
import { translate, type Language } from '../i18n/index.ts';

const log = createLogger('ui');

export interface ErrorBoundaryProps {
  readonly language: Language;
  readonly children: ReactNode;
}

/**
 * Last line of defence for a render error.
 *
 * Without one, an exception anywhere in the tree unmounts the whole app and
 * leaves a blank page — the worst possible dead end, because there is nothing
 * left to press. This keeps the player on a screen that says what happened and
 * offers the one action that reliably helps.
 *
 * It cannot use hooks (error boundaries must be class components), so it takes
 * the language as a prop rather than reading the store.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { readonly failed: boolean }> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.warn('render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    const t = (key: 'app.crashTitle' | 'app.crashBody' | 'app.crashReload'): string =>
      translate(this.props.language, key);
    return (
      <div className="page center">
        <h1>{t('app.crashTitle')}</h1>
        <p className="muted">{t('app.crashBody')}</p>
        <button
          type="button"
          className="btn btn--primary btn--lg btn--block"
          onClick={() => {
            window.location.reload();
          }}
        >
          <span className="btn__label">{t('app.crashReload')}</span>
        </button>
      </div>
    );
  }
}
