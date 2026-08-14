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
 * The colour choice for Change Colour.
 *
 * Four large targets, each carrying a colour, a shape and its name, so the choice
 * is never colour alone. The card being played is shown beside them: this dialog
 * interrupts a move, and it has to be obvious which move.
 *
 * It asks one question and nothing else. The last-card shout was offered here for
 * a while, armed ahead of the colour so that the two halves travelled in one
 * gesture — but that opened the declaration *before* the colour was chosen, which
 * is earlier than the rest of the table can see anything at all. Nothing about a
 * card that is still in hand is anybody's business yet: the declaration and the
 * catch both open when the card lands, and the head start in
 * {@link import('../../network/timing.ts').LAST_CARD_GRACE_MS} is what covers the
 * reach from this dialog closing to the declare button underneath it.
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
