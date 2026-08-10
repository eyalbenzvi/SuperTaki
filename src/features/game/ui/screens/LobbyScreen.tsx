import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../../../components/Badge.tsx';
import { Button } from '../../../../components/Button.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import { QrCode } from '../../../../components/QrCode.tsx';
import { SegmentedControl } from '../../../../components/SegmentedControl.tsx';
import { useT } from '../../../../app/useT.ts';
import { canShare, copyText, shareLink } from '../../../../lib/share.ts';
import { MAX_PLAYERS, MIN_PLAYERS, type GameMode } from '../../engine/state.ts';
import type { LobbyPlayer } from '../../network/protocol.ts';
import {
  amCreator,
  everyoneConnected,
  seatedPlayers,
  standInEnabled,
  tableGameMode,
} from '../../state/selectors.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
import { HealthBadge } from '../components/TableParts.tsx';

const PLAYER_COUNTS = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, index) => MIN_PLAYERS + index,
);

/** How long "Copied" stays on the button before it offers to copy again. */
const COPIED_MS = 2000;

/**
 * The waiting room.
 *
 * Its whole job is to get other people into the room, so the two things that do
 * that lead: the room code, to read out or type, and the invite link as a QR
 * code for a phone that is in the room already. The link itself — three wrapped
 * lines of URL that nobody types by hand — stays folded away behind Copy and
 * Share. Below that, who is in, and then the one action that matters.
 */
export function LobbyScreen(): ReactNode {
  const t = useT();
  const state = useAppStore();
  const players = seatedPlayers(state);
  const host = amCreator(state);
  const allConnected = everyoneConnected(state);

  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<LobbyPlayer | null>(null);

  const inviteUrl = state.inviteUrl;
  const roomCode = state.roomCode;
  const roomLimit = state.lobby?.maxPlayers ?? MAX_PLAYERS;
  const canStart = host && players.length >= MIN_PLAYERS;
  const standIn = standInEnabled(state);
  const mode = tableGameMode(state);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => {
      setCopied(null);
    }, COPIED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const copy = (what: 'code' | 'link', value: string | null): void => {
    if (!value) {
      return;
    }
    void copyText(value).then((ok) => {
      setCopied(ok ? what : null);
      setShareNote(ok ? null : t('lobby.shareUnavailable'));
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

      <section className="panel invite" aria-labelledby="invite-title">
        <h2 className="panel__title" id="invite-title">
          {t('lobby.inviteTitle')}
        </h2>
        <p className="text-small muted">{t('lobby.inviteBody')}</p>

        {/*
          The two ways in, side by side once there is room for them: the code to
          read out or type, and the same invite link as a picture for a phone
          that is in the room already.
        */}
        <div className="invite__ways">
          <p className="room-code">
            <span className="room-code__label">{t('lobby.roomCode')}</span>
            <span className="room-code__value code-value">{roomCode ?? '—'}</span>
          </p>
          {inviteUrl ? (
            <QrCode
              value={inviteUrl}
              label={t('lobby.qrLabel', { room: roomCode ?? '' })}
              caption={t('lobby.qrCaption')}
            />
          ) : null}
        </div>

        <div className="btn-group btn-group--fill">
          <Button
            icon={copied === 'code' ? 'check' : 'copy'}
            onClick={() => {
              copy('code', roomCode);
            }}
          >
            {copied === 'code' ? t('common.copied') : t('common.copyCode')}
          </Button>
          {inviteUrl ? (
            <Button
              icon={copied === 'link' ? 'check' : 'link'}
              onClick={() => {
                copy('link', inviteUrl);
              }}
            >
              {copied === 'link' ? t('common.copied') : t('common.copy')}
            </Button>
          ) : null}
          {inviteUrl && canShare() ? (
            <Button variant="primary" icon="share" onClick={doShare}>
              {t('common.share')}
            </Button>
          ) : null}
        </div>

        {shareNote ? <span className="field__hint">{shareNote}</span> : null}

        {inviteUrl ? (
          <details className="disclosure">
            <summary>{t('lobby.inviteLink')}</summary>
            <span className="invite-url">{inviteUrl}</span>
          </details>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="players-title">
        <h2 className="panel__title" id="players-title">
          {t('lobby.playerCount', {
            count: players.length,
            max: state.lobby?.maxPlayers ?? MAX_PLAYERS,
          })}
        </h2>

        {/*
         * Said to the whole table, not only to the seat that chose it: the settings
         * panel above is the creator's, and a mode that changes what winning means
         * is not something the others should meet for the first time mid-round.
         */}
        {mode === 'stairs' ? (
          <p className="text-small muted">
            <Badge icon="stairs">{t('mode.stairs')}</Badge> {t('mode.stairsHint')}
          </p>
        ) : null}

        <ul className="player-list">
          {players.map((player, index) => (
            <li className="player-list__item" key={player.id}>
              <span className="player-list__seat" aria-hidden="true">
                {index + 1}
              </span>
              <span className="player-list__name truncate" title={player.name}>
                {player.name}
                {player.id === state.localPlayerId ? (
                  <span className="text-small muted"> ({t('common.you')})</span>
                ) : null}
              </span>
              <span className="sr-only">{t('lobby.seatLabel', { seat: index + 1 })}</span>
              {player.isCreator ? (
                <Badge tone="accent" icon="crown">
                  {t('common.creator')}
                </Badge>
              ) : null}
              {/* A robot is always here, so a connection badge beside it would be
                  reporting on a connection that does not exist. */}
              {player.bot ? (
                <Badge icon="robot">{t('robot.badge')}</Badge>
              ) : (
                <HealthBadge health={player.health} t={t} />
              )}
              {/*
                Two removals, deliberately not one control.

                Taking a person out of the room ends something they are part of, so it
                is an icon that asks first. A robot is a chair the host put there a tap
                ago and can put back with another tap: it says "Remove" in words, it
                does it immediately, and it is legible as an offer rather than hidden
                behind a glyph beside a badge. Both are the lobby's alone — once the
                round is dealt the seats are the round's, and this screen is gone.
              */}
              {host && player.bot ? (
                <Button
                  icon="remove"
                  variant="ghost"
                  size="sm"
                  aria-label={t('robot.removeLabel', { name: player.name })}
                  onClick={() => {
                    state.removePlayer(player.id);
                  }}
                >
                  {t('robot.remove')}
                </Button>
              ) : host && !player.isCreator ? (
                <Button
                  iconOnly
                  icon="remove"
                  variant="ghost"
                  size="sm"
                  aria-label={t('lobby.remove', { name: player.name })}
                  onClick={() => {
                    setPendingRemoval(player);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>

        {host ? (
          <div className="stack stack--tight">
            <Button icon="robot" onClick={state.addBot} disabled={players.length >= roomLimit}>
              {t('robot.add')}
            </Button>
            <span className="field__hint">
              {players.length >= roomLimit
                ? t('robot.roomFull')
                : players.some((player) => player.bot === true)
                  ? // Says the deadline out loud while there is still a robot to remove:
                    // the control beside the seat is only here until the deal.
                    t('robot.removeHint')
                  : t('robot.addHint')}
            </span>
          </div>
        ) : null}

        {players.length < MIN_PLAYERS ? (
          <p className="text-small muted">{t('lobby.alone')}</p>
        ) : host ? (
          <p className="text-small muted">{t('lobby.readyToStart')}</p>
        ) : null}
      </section>

      {host ? (
        <details className="panel disclosure disclosure--panel">
          <summary>{t('lobby.settings')}</summary>
          <div className="stack">
            <span className="field__label">{t('create.maxPlayers')}</span>
            <SegmentedControl<number>
              block
              label={t('create.maxPlayers')}
              value={state.lobby?.maxPlayers ?? MAX_PLAYERS}
              onChange={state.setMaxPlayers}
              options={PLAYER_COUNTS.map((count) => ({
                value: count,
                label: String(count),
              }))}
            />
            <span className="field__hint">{t('lobby.maxPlayersLocked')}</span>

            {/*
             * The same choice the create screen offers, still open until the deal.
             * It is here rather than only there because a table that has just filled
             * up is exactly when somebody says "let's play stairs this time", and the
             * alternative was closing the room and opening another one.
             */}
            <span className="field__label">{t('mode.label')}</span>
            <SegmentedControl<GameMode>
              block
              label={t('mode.label')}
              value={mode}
              onChange={state.setGameMode}
              options={[
                { value: 'classic', label: t('mode.classic') },
                { value: 'stairs', label: t('mode.stairs') },
              ]}
            />
            <span className="field__hint">
              {mode === 'stairs' ? t('mode.stairsHint') : t('mode.classicHint')}
            </span>

            {/*
              Playing somebody's hand for them is the table's decision, so it is
              made here, in the open, where every player can see the answer in the
              lobby snapshot rather than discovering it mid-round.
            */}
            <span className="field__label">{t('robot.standInLabel')}</span>
            <SegmentedControl<'on' | 'off'>
              block
              label={t('robot.standInLabel')}
              value={standIn ? 'on' : 'off'}
              onChange={(value) => {
                state.setStandInEnabled(value === 'on');
              }}
              options={[
                { value: 'on', label: t('common.on') },
                { value: 'off', label: t('common.off') },
              ]}
            />
            <span className="field__hint">{standIn ? t('robot.standInHint') : t('robot.standInOff')}</span>
          </div>
        </details>
      ) : null}

      {/*
        The one action of the screen, pinned where a thumb reaches it however
        long the roster gets.
      */}
      <div className="action-bar">
        {host ? (
          <>
            <Button variant="primary" size="lg" block disabled={!canStart} onClick={startGame}>
              {t('lobby.start')}
            </Button>
            {canStart ? null : <p className="action-bar__hint">{t('lobby.startHint')}</p>}
          </>
        ) : (
          <p className="action-bar__hint" role="status">
            {t('lobby.waitingForHost')}
          </p>
        )}
      </div>

      <Modal
        open={confirmStart}
        title={t('lobby.confirmStartTitle')}
        onClose={() => {
          setConfirmStart(false);
        }}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmStart(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmStart(false);
                state.startGame();
              }}
            >
              {t('lobby.confirmStartAction')}
            </Button>
          </>
        }
      >
        <p>{t('lobby.confirmStartBody')}</p>
      </Modal>

      {/*
        Removing somebody is destructive and irreversible from their side, and the
        control sits beside their name in a list — exactly the shape of a mis-tap.
      */}
      <Modal
        open={pendingRemoval !== null}
        title={t('lobby.removeTitle', { name: pendingRemoval?.name ?? '' })}
        onClose={() => {
          setPendingRemoval(null);
        }}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingRemoval(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingRemoval) {
                  state.removePlayer(pendingRemoval.id);
                }
                setPendingRemoval(null);
              }}
            >
              {t('lobby.removeAction')}
            </Button>
          </>
        }
      >
        <p>{t('lobby.removeBody')}</p>
      </Modal>
    </div>
  );
}
