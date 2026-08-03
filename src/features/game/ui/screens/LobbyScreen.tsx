import { useState, type ReactNode } from 'react';
import { Modal } from '../../../../components/Modal.tsx';
import { SegmentedControl } from '../../../../components/SegmentedControl.tsx';
import { useT } from '../../../../app/useT.ts';
import { canShare, copyText, shareLink } from '../../../../lib/share.ts';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../engine/state.ts';
import { everyoneConnected, isHost, seatedPlayers } from '../../state/selectors.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
import { HealthBadge } from '../components/TableParts.tsx';

const PLAYER_COUNTS = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, index) => MIN_PLAYERS + index,
);

export function LobbyScreen(): ReactNode {
  const t = useT();
  const state = useAppStore();
  const players = seatedPlayers(state);
  const host = isHost(state);
  const allConnected = everyoneConnected(state);

  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const inviteUrl = state.inviteUrl;
  const canStart = host && players.length >= MIN_PLAYERS;

  const doCopy = (): void => {
    if (!inviteUrl) {
      return;
    }
    void copyText(inviteUrl).then((ok) => {
      setCopied(ok);
      if (!ok) {
        setShareNote(t('lobby.shareUnavailable'));
      }
    });
  };

  const doShare = (): void => {
    if (!inviteUrl) {
      return;
    }
    void shareLink({ title: t('app.title'), text: t('home.join'), url: inviteUrl }).then((ok) => {
      if (!ok) {
        setShareNote(t('lobby.shareUnavailable'));
      }
    });
  };

  const startGame = (): void => {
    if (allConnected) {
      state.startGame();
    } else {
      setConfirmStart(true);
    }
  };

  return (
    <div className="page">
      <h1>{t('lobby.title')}</h1>

      <ConnectionPhaseNotice />

      <section className="panel invite-panel">
        <div className="data-row">
          <span className="field__label">{t('lobby.roomCode')}</span>
          <span className="code-value">{state.roomCode ?? '—'}</span>
        </div>

        {inviteUrl ? (
          <div className="stack">
            <span className="field__label">{t('lobby.inviteLink')}</span>
            <span className="invite-url">{inviteUrl}</span>
            <div className="btn-group">
              <button type="button" className="btn" onClick={doCopy}>
                {copied ? t('common.copied') : t('common.copy')}
              </button>
              {canShare() ? (
                <button type="button" className="btn" onClick={doShare}>
                  {t('common.share')}
                </button>
              ) : null}
            </div>
            {shareNote ? <span className="field__hint">{shareNote}</span> : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="row row--between">
          <h2 className="panel__title">
            {t('lobby.playerCount', {
              count: players.length,
              max: state.lobby?.maxPlayers ?? MAX_PLAYERS,
            })}
          </h2>
        </div>

        <ul className="player-list">
          {players.map((player) => (
            <li className="player-list__item" key={player.id}>
              <span className="player-list__name">
                {player.name}
                {player.id === state.localPlayerId ? (
                  <span className="text-small muted"> ({t('common.you')})</span>
                ) : null}
              </span>
              {player.isHost ? <span className="badge badge--host">{t('common.host')}</span> : null}
              <HealthBadge health={player.health} t={t} />
              {host && !player.isHost ? (
                <button
                  type="button"
                  className="btn btn--danger btn--ghost"
                  aria-label={t('lobby.remove', { name: player.name })}
                  onClick={() => {
                    state.removePlayer(player.id);
                  }}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {host ? (
        <section className="panel stack">
          <span className="field__label">{t('create.maxPlayers')}</span>
          <SegmentedControl<number>
            label={t('create.maxPlayers')}
            value={state.lobby?.maxPlayers ?? MAX_PLAYERS}
            onChange={state.setMaxPlayers}
            options={PLAYER_COUNTS.map((count) => ({
              value: count,
              label: String(count),
            }))}
          />
          <span className="field__hint">{t('lobby.maxPlayersLocked')}</span>
        </section>
      ) : null}

      <div className="btn-group">
        {host ? (
          <button
            type="button"
            className="btn btn--primary btn--large"
            disabled={!canStart}
            onClick={startGame}
          >
            {t('lobby.start')}
          </button>
        ) : (
          <p className="muted" role="status">
            {t('lobby.waitingForHost')}
          </p>
        )}
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            setConfirmLeave(true);
          }}
        >
          {t('common.leave')}
        </button>
      </div>
      {host && !canStart ? <p className="text-small muted">{t('lobby.startHint')}</p> : null}

      <Modal
        open={confirmStart}
        title={t('lobby.confirmStartTitle')}
        onClose={() => {
          setConfirmStart(false);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setConfirmStart(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setConfirmStart(false);
                state.startGame();
              }}
            >
              {t('lobby.confirmStartAction')}
            </button>
          </>
        }
      >
        <p>{t('lobby.confirmStartBody')}</p>
      </Modal>

      <Modal
        open={confirmLeave}
        title={t('lobby.leaveTitle')}
        onClose={() => {
          setConfirmLeave(false);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setConfirmLeave(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={state.leaveRoom}>
              {t('common.leave')}
            </button>
          </>
        }
      >
        <p>{host ? t('lobby.leaveBodyHost') : t('lobby.leaveBodyGuest')}</p>
      </Modal>
    </div>
  );
}
