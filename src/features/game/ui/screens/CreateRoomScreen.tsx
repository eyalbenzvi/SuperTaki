import { useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Field } from '../../../../components/Field.tsx';
import { SegmentedControl } from '../../../../components/SegmentedControl.tsx';
import { useT } from '../../../../app/useT.ts';
import { LANGUAGES, type Language } from '../../../../i18n/index.ts';
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from '../../../../lib/sanitize.ts';
import { MAX_PLAYERS, MIN_PLAYERS, type GameMode } from '../../engine/state.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';

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
  const [gameMode, setGameMode] = useState<GameMode>('classic');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const cleaned = sanitizeDisplayName(name);
    if (cleaned.length === 0) {
      setError(t('create.nameRequired'));
      return;
    }
    setError(null);
    void createRoom({ name: cleaned, maxPlayers, tableLanguage, gameMode });
  };

  return (
    <div className="page">
      <h1>{t('create.title')}</h1>

      {/* A room that fails to open must say so here; the player never reaches
          the lobby, so the lobby's notice would never be shown. */}
      <ConnectionPhaseNotice />

      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label={t('create.nameLabel')}
          hint={t('create.nameHint')}
          error={error}
          value={name}
          placeholder={t('create.namePlaceholder')}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          autoComplete="nickname"
          autoFocus
          enterKeyHint="go"
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />

        <div className="field">
          <span className="field__label">{t('create.maxPlayers')}</span>
          <SegmentedControl<number>
            block
            label={t('create.maxPlayers')}
            value={maxPlayers}
            onChange={setMaxPlayers}
            options={PLAYER_COUNTS.map((count) => ({ value: count, label: String(count) }))}
          />
        </div>

        {/*
         * How the round is won, decided before the table exists rather than
         * mid-game: it changes what running out of cards means, so it is not a thing
         * to discover halfway through a hand. The hint under it says what the choice
         * actually does, because "stairs" means nothing to somebody who has not
         * played it.
         */}
        <div className="field">
          <span className="field__label">{t('mode.label')}</span>
          <SegmentedControl<GameMode>
            block
            label={t('mode.label')}
            value={gameMode}
            onChange={setGameMode}
            options={[
              { value: 'classic', label: t('mode.classic') },
              { value: 'stairs', label: t('mode.stairs') },
            ]}
          />
          <span className="field__hint">
            {gameMode === 'stairs' ? t('mode.stairsHint') : t('mode.classicHint')}
          </span>
        </div>

        <div className="field">
          <span className="field__label">{t('create.tableLanguage')}</span>
          <SegmentedControl<Language>
            block
            label={t('create.tableLanguage')}
            value={tableLanguage}
            onChange={setTableLanguage}
            options={LANGUAGES.map((code) => ({ value: code, label: t(`language.${code}`) }))}
          />
          <span className="field__hint">{t('create.tableLanguageHint')}</span>
        </div>

        <div className="form-actions">
          <Button type="submit" variant="primary" size="lg" block busy={busy}>
            {busy ? t('create.creating') : t('create.submit')}
          </Button>
          {/* Stays live while the room is opening: a broker that never answers
              must not leave the player on a screen with one dead button. */}
          <Button
            variant="ghost"
            block
            onClick={() => {
              goTo('home');
            }}
          >
            {t('common.back')}
          </Button>
        </div>
      </form>
    </div>
  );
}
