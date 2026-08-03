import type { ReactNode } from 'react';
import { useT } from '../../../../app/useT.ts';
import type { TranslationKey, Translator } from '../../../../i18n/index.ts';
import { useAppStore } from '../../state/store.ts';

interface RuleSection {
  readonly title: TranslationKey;
  readonly items: readonly TranslationKey[];
  /** Included in the compact in-game help drawer. */
  readonly essential: boolean;
}

const SECTIONS: readonly RuleSection[] = [
  {
    title: 'rules.turnTitle',
    items: ['rules.turnPlay', 'rules.turnDraw', 'rules.turnWin'],
    essential: true,
  },
  {
    title: 'rules.specialTitle',
    items: ['rules.specialStop', 'rules.specialPlus', 'rules.specialDirection', 'rules.specialColorChange'],
    essential: true,
  },
  {
    title: 'rules.takiTitle',
    items: [
      'rules.takiOpen',
      'rules.takiContinue',
      'rules.takiNoWild',
      'rules.takiClose',
      'rules.takiEffect',
    ],
    essential: true,
  },
  { title: 'rules.superTakiTitle', items: ['rules.superTaki'], essential: true },
  {
    title: 'rules.deckTitle',
    items: ['rules.deckNumbers', 'rules.deckActions', 'rules.deckWilds', 'rules.deckNote'],
    essential: false,
  },
  { title: 'rules.setupTitle', items: ['rules.setupDeal', 'rules.setupOpening'], essential: false },
  { title: 'rules.pileTitle', items: ['rules.pileRecycle', 'rules.pileEmpty'], essential: false },
  {
    title: 'rules.choicesTitle',
    items: [
      'rules.choicesNoStacking',
      'rules.choicesNoDeclaration',
      'rules.choicesWinOnSpecial',
      'rules.choicesTwoPlayers',
    ],
    essential: false,
  },
  { title: 'rules.scoringTitle', items: ['rules.scoring'], essential: false },
];

export interface RulesBodyProps {
  readonly t: Translator;
  /** Renders only the sections needed mid-game. */
  readonly compact?: boolean;
}

/** The single source of the in-app rules, shared by the page and the drawer. */
export function RulesBody({ t, compact = false }: RulesBodyProps): ReactNode {
  const sections = compact ? SECTIONS.filter((section) => section.essential) : SECTIONS;
  return (
    <div className="rules">
      {compact ? null : <p>{t('rules.intro')}</p>}
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{t(section.title)}</h2>
          <ul>
            {section.items.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function RulesScreen(): ReactNode {
  const t = useT();
  const closeRules = useAppStore((state) => state.closeRules);

  return (
    <div className="page">
      <h1>{t('rules.title')}</h1>
      <RulesBody t={t} />
      <div className="btn-group">
        <button type="button" className="btn btn--primary" onClick={closeRules}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}
