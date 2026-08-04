import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Field } from '../../../../components/Field.tsx';
import { useT } from '../../../../app/useT.ts';
import { clearHash, inviteFromHash } from '../../../../app/routing.ts';
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from '../../../../lib/sanitize.ts';
import { parseInvite } from '../../network/roomCode.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
import { ConnectivityNotice } from '../components/ConnectivityNotice.tsx';
import { ResumeCard } from '../components/ResumeCard.tsx';

export function JoinRoomScreen(): ReactNode {
  const t = useT();
  const storedName = useAppStore((state) => state.displayName);
  const busy = useAppStore((state) => state.busy);
  const resumable = useAppStore((state) => state.resumable);
  const joinRoom = useAppStore((state) => state.joinRoom);
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

      <ConnectionPhaseNotice />
      <ConnectivityNotice />

      <ResumeCard onResume={resume} busy={busy} />

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
        <Field
          label={t('join.nameLabel')}
          error={nameError}
          value={name}
          placeholder={t('create.namePlaceholder')}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          autoComplete="nickname"
          autoFocus={!detectedRoom}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
        />

        {/*
          A room code is upper-case, hyphenated and not a word: the phone keyboard
          has to be told so, or it capitalises the first letter only, offers
          autocorrect and hides the hyphen behind a modifier key.
        */}
        <Field
          label={t('join.inviteLabel')}
          hint={t('join.inviteHint')}
          error={inviteError}
          inputClass="code-input"
          value={invite}
          placeholder={t('join.invitePlaceholder')}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(event) => {
            setInvite(event.target.value);
            setInviteError(null);
          }}
        />

        <div className="form-actions">
          <Button type="submit" variant="primary" size="lg" block busy={busy}>
            {busy ? t('join.connecting') : t('join.submit')}
          </Button>
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
