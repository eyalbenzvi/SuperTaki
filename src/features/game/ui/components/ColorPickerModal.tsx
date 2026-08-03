import type { ReactNode } from 'react';
import { Modal } from '../../../../components/Modal.tsx';
import type { Translator } from '../../../../i18n/index.ts';
import { CARD_COLORS, type Card, type CardColor } from '../../engine/cards.ts';
import { colorName, describeCard } from '../cardText.ts';

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

/** Mobile-friendly colour choice for Colour Change and Super Taki. */
export function ColorPickerModal({ open, card, t, onChoose, onCancel }: ColorPickerModalProps): ReactNode {
  return (
    <Modal
      open={open && card !== null}
      title={card ? t('game.chooseColorFor', { card: describeCard(t, card) }) : t('game.chooseColorTitle')}
      onClose={onCancel}
      actions={
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      }
    >
      <p className="text-small muted">{t('game.chooseColorBody')}</p>
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
