import type { ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import type { Translator } from '../../../../i18n/index.ts';
import { CARD_COLORS, type Card, type CardColor } from '../../engine/cards.ts';
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
  readonly onChoose: (color: CardColor) => void;
  readonly onCancel: () => void;
}

/**
 * The colour choice for Change Colour and Super Taki.
 *
 * Four large targets, each carrying a colour, a shape and its name, so the choice
 * is never colour alone. The card being played is shown beside them: this dialog
 * interrupts a move, and it has to be obvious which move.
 */
export function ColorPickerModal({ open, card, t, onChoose, onCancel }: ColorPickerModalProps): ReactNode {
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
