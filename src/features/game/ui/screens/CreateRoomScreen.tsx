import { useState, type ReactNode } from 'react';
import { SegmentedControl } from '../../../../components/SegmentedControl.tsx';
import { useT } from '../../../../app/useT.ts';
import { LANGUAGES, type Language } from '../../../../i18n/index.ts';
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from '../../../../lib/sanitize.ts';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../engine/state.ts';
import { useAppStore } from '../../state/store.ts';

const PLAYER_COUNTS = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, index) => MIN_PLAYERS + index,
);

export function CreateRoomScreen(): ReactNode {
  const t = useT();
  const language = useAppStore((state) => state.language);
  const storedName = useAppStore((state) => state.displayName);
  const busy = useAppStore((state) => state.busy);
  const createRoom = useAppStore((state) => state.createRoom);
  const goTo = useAppStore((state) => state.goTo);

  const [name, setName] = useState(storedName);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [tableLanguage, setTableLanguage] = useState<Language>(language);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const cleaned = sanitizeDisplayName(name);
    if (cleaned.length === 0) {
      setError(t('create.nameRequired'));
      return;
    }
    setError(null);
    void createRoom({ name: cleaned, maxPlayers, tableLanguage });
  };

  return (
    <div className="page">
      <h1>{t('create.title')}</h1>

      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="create-name">
            {t('create.nameLabel')}
          </label>
          <input
            id="create-name"
            className="input"
            value={name}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="nickname"
            aria-describedby="create-name-hint"
            aria-invalid={error !== null}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          <span className="field__hint" id="create-name-hint">
            {t('create.nameHint')}
          </span>
          {error ? (
            <span className="field__error" role="alert">
              {error}
            </span>
          ) : null}
        </div>

        <div className="field">
          <span className="field__label" id="max-players-label">
            {t('create.maxPlayers')}
          </span>
          <SegmentedControl<number>
            label={t('create.maxPlayers')}
            value={maxPlayers}
            onChange={setMaxPlayers}
            options={PLAYER_COUNTS.map((count) => ({ value: count, label: String(count) }))}
          />
        </div>

        <div className="field">
          <span className="field__label">{t('create.tableLanguage')}</span>
          <SegmentedControl<Language>
            label={t('create.tableLanguage')}
            value={tableLanguage}
            onChange={setTableLanguage}
            options={LANGUAGES.map((code) => ({ value: code, label: t(`language.${code}`) }))}
          />
          <span className="field__hint">{t('create.tableLanguageHint')}</span>
        </div>

        <div className="btn-group">
          <button type="submit" className="btn btn--primary btn--large" disabled={busy}>
            {busy ? t('create.creating') : t('create.submit')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              goTo('home');
            }}
          >
            {t('common.back')}
          </button>
        </div>
      </form>
    </div>
  );
}
