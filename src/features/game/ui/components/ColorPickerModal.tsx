import type { ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Icon } from '../../../../components/Icon.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import type { Translator } from '../../../../i18n/index.ts';
import { CARD_COLORS, LAST_CARD_PENALTY, type Card, type CardColor } from '../../engine/cards.ts';
import { colorName, describeCard } from '../cardText.ts';
import { CardFace } from './CardView.tsx';

/** Distinct shapes so the four options are distinguishable without colour. */
const COLOR_GLYPH: Record<CardColor, string> = {
  red: '●',
  blue: '■',
  green: '▲',
  yellow: '◆',
};

export interface ColorPickerModalProps {
  readonly open: boolean;
  readonly card: Card | null;
  readonly t: Translator;
  /** True when playing this card leaves the player holding a single card. */
  readonly lastCardNext: boolean;
  /** Whether the shout is armed, so the colour tap carries it. */
  readonly declaring: boolean;
  readonly onToggleDeclare: () => void;
  readonly onChoose: (color: CardColor) => void;
  readonly onCancel: () => void;
}

/**
 * The colour choice for Change Colour and Super Taki.
 *
 * Four large targets, each carrying a colour, a shape and its name, so the choice
 * is never colour alone. The card being played is shown beside them: this dialog
 * interrupts a move, and it has to be obvious which move.
 *
 * When the card would leave its owner on one, the shout is offered here too — see
 * the note on the toggle below. Choosing a colour then plays and declares in the
 * same move.
 */
export function ColorPickerModal({
  open,
  card,
  t,
  lastCardNext,
  declaring,
  onToggleDeclare,
  onChoose,
  onCancel,
}: ColorPickerModalProps): ReactNode {
  return (
    <Modal
      open={open && card !== null}
      title={card ? t('game.chooseColorFor', { card: describeCard(t, card) }) : t('game.chooseColorTitle')}
      onClose={onCancel}
      actions={
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      }
    >
      <div className="color-picker-intro">
        {card ? <CardFace card={card} t={t} size="sm" /> : null}
        <p className="text-small muted">{t('game.chooseColorBody')}</p>
      </div>
      {/*
       * The shout, offered inside the interruption that would otherwise have cost
       * it.
       *
       * Every other card is a single tap: the hand comes down to one and the
       * declare button is already there to be reached for. This one puts a dialog
       * in between, so by the time the button appears the table has had its head
       * start and somebody else's thumb is on the catch. Arming it here puts the
       * two halves back in one gesture, which is what they are at a table.
       *
       * Off by default, and it has to be: the rule being enforced is remembering,
       * and a checkbox that remembers for you is not the same game.
       */}
      {lastCardNext ? (
        <button
          type="button"
          className={`color-picker__shout ${declaring ? 'color-picker__shout--armed' : ''}`.trim()}
          aria-pressed={declaring}
          onClick={onToggleDeclare}
        >
          <span className="color-picker__shout-mark" aria-hidden="true">
            <Icon name={declaring ? 'check' : 'alert'} size={1} />
          </span>
          <span className="color-picker__shout-text">
            <span className="color-picker__shout-title">{t('game.declareLastCard')}</span>
            <span className="color-picker__shout-why">
              {declaring
                ? t('game.declareWithPlayArmed')
                : t('game.declareWithPlay', { count: LAST_CARD_PENALTY })}
            </span>
          </span>
        </button>
      ) : null}
      <div className="color-picker">
        {CARD_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-picker__option color-picker__option--${color}`}
            onClick={() => {
              onChoose(color);
            }}
          >
            <span className="color-picker__glyph" aria-hidden="true">
              {COLOR_GLYPH[color]}
            </span>
            <span>{colorName(t, color)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
