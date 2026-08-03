import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../../../app/useT.ts';
import { clearHash, inviteFromHash } from '../../../../app/routing.ts';
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from '../../../../lib/sanitize.ts';
import { parseInvite } from '../../network/roomCode.ts';
import { useAppStore } from '../../state/store.ts';

export function JoinRoomScreen(): ReactNode {
  const t = useT();
  const storedName = useAppStore((state) => state.displayName);
  const busy = useAppStore((state) => state.busy);
  const resumable = useAppStore((state) => state.resumable);
  const joinRoom = useAppStore((state) => state.joinRoom);
  const forgetResumable = useAppStore((state) => state.forgetResumable);
  const goTo = useAppStore((state) => state.goTo);

  // Prefilled from the invite link on first render, so no effect has to
  // write state back into the form.
  const [detectedRoom] = useState(() => inviteFromHash(window.location.hash)?.roomCode ?? null);
  const [name, setName] = useState(storedName);
  const [invite, setInvite] = useState(detectedRoom ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Strip the invite from the address bar so a room code is not left behind in
  // the history of a shared device.
  useEffect(() => {
    if (detectedRoom) {
      clearHash();
    }
  }, [detectedRoom]);

  const submit = (): void => {
    const cleanedName = sanitizeDisplayName(name);
    const details = parseInvite(invite);
    let valid = true;

    if (cleanedName.length === 0) {
      setNameError(t('create.nameRequired'));
      valid = false;
    } else {
      setNameError(null);
    }
    if (!details) {
      setInviteError(t('join.invalidInvite'));
      valid = false;
    } else {
      setInviteError(null);
    }
    if (!valid || !details) {
      return;
    }

    void joinRoom({
      name: cleanedName,
      roomCode: details.roomCode,
      ...(details.hostPeerId ? { hostPeerId: details.hostPeerId } : {}),
    });
  };

  const resume = (): void => {
    if (!resumable) {
      return;
    }
    void joinRoom({
      name: resumable.displayName,
      roomCode: resumable.roomCode,
      hostPeerId: resumable.hostPeerId,
      resume: { playerId: resumable.playerId, resumeToken: resumable.resumeToken },
    });
  };

  return (
    <div className="page">
      <h1>{t('join.title')}</h1>

      {resumable ? (
        <div className="notice notice--info">
          <strong>{t('join.resumeTitle')}</strong>
          <span>{t('join.resumeBody', { room: resumable.roomCode, name: resumable.displayName })}</span>
          <div className="btn-group">
            <button type="button" className="btn btn--primary" onClick={resume} disabled={busy}>
              {t('join.resumeAction')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={forgetResumable}>
              {t('join.resumeDiscard')}
            </button>
          </div>
        </div>
      ) : null}

      {detectedRoom ? (
        <p className="text-small muted" role="status">
          {t('join.detected', { room: detectedRoom })}
        </p>
      ) : null}

      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="join-name">
            {t('join.nameLabel')}
          </label>
          <input
            id="join-name"
            className="input"
            value={name}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="nickname"
            aria-invalid={nameError !== null}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          {nameError ? (
            <span className="field__error" role="alert">
              {nameError}
            </span>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="join-invite">
            {t('join.inviteLabel')}
          </label>
          <input
            id="join-invite"
            className="input code-value"
            value={invite}
            placeholder={t('join.invitePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="join-invite-hint"
            aria-invalid={inviteError !== null}
            onChange={(event) => {
              setInvite(event.target.value);
              setInviteError(null);
            }}
          />
          <span className="field__hint" id="join-invite-hint">
            {t('join.inviteHint')}
          </span>
          {inviteError ? (
            <span className="field__error" role="alert">
              {inviteError}
            </span>
          ) : null}
        </div>

        <div className="btn-group">
          <button type="submit" className="btn btn--primary btn--large" disabled={busy}>
            {busy ? t('join.connecting') : t('join.submit')}
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
