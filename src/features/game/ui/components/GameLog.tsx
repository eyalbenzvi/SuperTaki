import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import type { Translator } from '../../../../i18n/index.ts';
import type { FeedEntry } from '../../state/store.ts';

export interface GameLogProps {
  readonly feed: readonly FeedEntry[];
  readonly describe: (entry: FeedEntry) => string;
  readonly t: Translator;
}

/**
 * What just happened, and the history behind it.
 *
 * The newest line is always on screen as a one-line ticker, because "what did
 * that card just do to me" is the question a player asks most often. The rest is
 * a dialog behind it: on a phone a permanently open log was costing a fifth of
 * the table to show four lines nobody was reading.
 *
 * The list is not a live region — the shell has one, and announcing a scrolling
 * history through it would bury the line that matters.
 */
export function GameLog({ feed, describe, t }: GameLogProps): ReactNode {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const latest = feed.length > 0 ? feed[feed.length - 1] : undefined;

  // Keep the newest line in view when the dialog is open, without taking focus.
  // The sheet is the scroller, not the list, so the last line asks to be shown
  // rather than the list being scrolled directly.
  useEffect(() => {
    if (open) {
      // Optional call: not every environment the tests run in implements it.
      listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, feed]);

  return (
    <>
      {/*
       * The pill is keyed on the newest entry, so a new line remounts it and
       * replays the flash. A `key` rather than a timer in state: watching the id
       * in an effect and setting a flag would be a `set-state-in-effect` error,
       * and this costs nothing.
       */}
      <div key={latest?.id ?? 'empty'} className="ticker ticker__flash">
        <p className="ticker__text truncate">{latest ? describe(latest) : t('game.feedEmpty')}</p>
        <Button
          size="sm"
          variant="ghost"
          icon="log"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('game.feedOpen')}
        </Button>
      </div>

      <Modal
        open={open}
        title={t('game.feedTitle')}
        onClose={() => {
          setOpen(false);
        }}
        closeLabel={t('common.close')}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('common.close')}
          </Button>
        }
      >
        {feed.length === 0 ? (
          <p className="muted">{t('game.feedEmpty')}</p>
        ) : (
          <ol className="feed" ref={listRef}>
            {feed.map((entry, index) => (
              <li
                key={entry.id}
                className={`feed__item ${index === feed.length - 1 ? 'feed__item--latest' : ''}`.trim()}
              >
                {describe(entry)}
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </>
  );
}
