import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { GUEST_ID, HOST_ID, enterGame, lobbyFixture, renderApp, resetStore, setState } from './helpers.tsx';
import type { Card } from '../../src/features/game/engine/cards.ts';
import { depthBucket } from '../../src/features/game/ui/pileDepth.ts';
import { useAppStore } from '../../src/features/game/state/store.ts';

beforeEach(resetStore);

const red5: Card = { id: 'c1', kind: 'number', color: 'red', value: 5 };
const red7: Card = { id: 'c2', kind: 'number', color: 'red', value: 7 };
const blue3: Card = { id: 'c3', kind: 'number', color: 'blue', value: 3 };
const red9: Card = { id: 'c4', kind: 'number', color: 'red', value: 9 };

function table(options: { hand: readonly Card[]; myTurn?: boolean; patch?: Record<string, unknown> }): void {
  const fixture = enterGame({ myTurn: options.myTurn ?? true });
  setState({
    hand: options.hand,
    publicState: {
      ...fixture.publicState,
      currentPlayerId: (options.myTurn ?? true) ? HOST_ID : GUEST_ID,
      discardTop: red9,
      activeColor: 'red',
      players: [
        { id: HOST_ID, name: 'דנה', cardCount: options.hand.length },
        { id: GUEST_ID, name: 'אלי', cardCount: 5 },
      ],
      ...options.patch,
    },
  });
}

describe('the hand as a keyboard widget', () => {
  it('exposes one tab stop and moves along the fan with the arrow keys', async () => {
    // Right-to-left is the default, so ArrowLeft moves the way the key points.
    table({ hand: [blue3, red5, red7] });
    const { user } = renderApp();

    const cards = screen.getAllByRole('button', { name: /^הנחת/ });
    const stops = cards.filter((card) => card.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    // The tab stop starts on the first card that can actually be played.
    expect(stops[0]).toHaveAccessibleName('הנחת אדום 5');

    stops[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 7');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 5');
    // Home and End follow the fan's own order, which is the sorted hand:
    // red 5, red 7, blue 3.
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAccessibleName('הנחת כחול 3');
    await user.keyboard('{Home}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 5');
  });

  it('plays the focused card with the keyboard', async () => {
    const playCard = vi.fn();
    table({ hand: [red5] });
    setState({ playCard });
    const { user } = renderApp();

    screen.getByRole('button', { name: 'הנחת אדום 5' }).focus();
    await user.keyboard('{Enter}');
    expect(playCard).toHaveBeenCalledWith(red5.id);
  });

  it('shows the hand in colour order rather than deal order', () => {
    table({ hand: [blue3, red7, red5] });
    renderApp();
    expect(
      screen.getAllByRole('button', { name: /^הנחת/ }).map((card) => card.getAttribute('aria-label')),
    ).toEqual(['הנחת אדום 5', 'הנחת אדום 7', 'הנחת כחול 3']);
  });
});

describe('a move in flight', () => {
  it('locks the hand and the pile until the table answers', async () => {
    const playCard = vi.fn();
    table({ hand: [red5, red7] });
    setState({ playCard, actionPending: true });
    const { user } = renderApp();

    // One tap must never become two moves: the host would reject the duplicate,
    // and the player would be told a card they legitimately played is not theirs.
    await user.click(screen.getByRole('button', { name: 'הנחת אדום 5' }));
    expect(playCard).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /חבילת משיכה/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('שולח את המהלך…');
  });

  it('says so in the prompt while waiting', () => {
    table({ hand: [red5] });
    setState({ actionPending: true });
    renderApp();
    expect(screen.getByText('שולח את המהלך…')).toBeInTheDocument();
  });
});

describe('what to do now', () => {
  it('tells a player on turn that they may play or draw', () => {
    table({ hand: [red5] });
    renderApp();
    expect(screen.getByText('אפשר להניח קלף או למשוך.')).toBeInTheDocument();
  });

  it('names the player being waited for when it is not your turn', () => {
    table({ hand: [red5], myTurn: false });
    renderApp();
    expect(screen.getByText('ממתינים לאלי…')).toBeInTheDocument();
  });

  it('shows one prompt at a time, in priority order', () => {
    // A pending draw and a pending Plus at once: the debt is the thing to answer.
    table({ hand: [red5], patch: { pendingDraw: 2, pendingPlus: true } });
    renderApp();
    expect(screen.getByText('מחכים לך 2 קלפים. אפשר לענות בקח 2 או במלך, או לקחת אותם.')).toBeInTheDocument();
    expect(screen.queryByText('הונח פלוס — חייבים להניח עוד קלף.')).not.toBeInTheDocument();
  });

  it('uses the singular when a single card is owed', () => {
    table({ hand: [red5], patch: { pendingDraw: 1 } });
    renderApp();
    expect(screen.getByRole('button', { name: 'לקיחת קלף אחד' })).toBeInTheDocument();
  });
});

describe('the other players', () => {
  it('marks the player on turn without saying it is your turn', () => {
    table({ hand: [red5], myTurn: false });
    renderApp();
    const seats = screen.getByRole('region', { name: 'שאר השחקנים' });
    // The old badge read "your turn" on somebody else's seat.
    expect(within(seats).getByText('משחק/ת עכשיו')).toBeInTheDocument();
    expect(within(seats).queryByText('תור שלך')).not.toBeInTheDocument();
  });

  /** Both players down to a single card, with the guest not having declared. */
  function lastCards(declared: readonly string[] = []): void {
    const fixture = enterGame({ myTurn: true });
    setState({
      hand: [red5],
      publicState: {
        ...fixture.publicState,
        currentPlayerId: HOST_ID,
        declaredLastCard: declared,
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 1 },
          { id: GUEST_ID, name: 'אלי', cardCount: 1 },
        ],
      },
      lobby: lobbyFixture({ phase: 'inGame' }),
    });
  }

  /*
   * The button arrives a beat after the seat does. A player has to see
   * their own last card land and then find the declare button, while everybody
   * else is already looking at a seat that says "1 card" — so the head start is
   * what keeps the rule about declaring rather than about thumb speed. The host
   * refuses a catch inside the same window whatever a client renders; this is
   * only what stops the button from being there to press.
   */
  it('offers to call out an opponent sitting silently on their last card', async () => {
    const catchLastCard = vi.fn();
    lastCards();
    setState({ catchLastCard });
    const { user } = renderApp();

    const seats = screen.getByRole('region', { name: 'שאר השחקנים' });
    expect(within(seats).getByText('קלף אחד')).toBeInTheDocument();
    expect(within(seats).queryByRole('button', { name: 'תפיסת אלי' })).not.toBeInTheDocument();

    await user.click(await within(seats).findByRole('button', { name: 'תפיסת אלי' }));
    expect(catchLastCard).toHaveBeenCalledWith(GUEST_ID);
  });

  it('shows the declaration instead, once it has been made', () => {
    lastCards([GUEST_ID]);
    renderApp();
    const seats = screen.getByRole('region', { name: 'שאר השחקנים' });
    expect(within(seats).getByText('הכריז/ה')).toBeInTheDocument();
    expect(within(seats).queryByRole('button', { name: 'תפיסת אלי' })).not.toBeInTheDocument();
  });
});

/**
 * A catch is the one penalty another player hands out, and with three at the
 * table "somebody drew four" does not say who called it. The log cannot carry it:
 * its visible line is the newest, and the draw follows the catch immediately.
 */
describe('a "last card" catch, said to the whole table', () => {
  const CAROL_ID = 'pl_carol00000';

  /** Three seats, so the caller is genuinely ambiguous without being named. */
  function threeHanded(): void {
    const fixture = enterGame({ myTurn: true });
    setState({
      hand: [red5],
      publicState: {
        ...fixture.publicState,
        currentPlayerId: HOST_ID,
        discardTop: red9,
        activeColor: 'red',
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 1 },
          { id: GUEST_ID, name: 'אלי', cardCount: 5 },
          { id: CAROL_ID, name: 'נועה', cardCount: 5 },
        ],
      },
      lobby: lobbyFixture({
        phase: 'inGame',
        players: [
          { id: HOST_ID, name: 'דנה', isCreator: true, health: 'connected', seat: 0 },
          { id: GUEST_ID, name: 'אלי', isCreator: false, health: 'connected', seat: 1 },
          { id: CAROL_ID, name: 'נועה', isCreator: false, health: 'connected', seat: 2 },
        ],
      }),
    });
  }

  it('names the player who called it, and the one who paid', () => {
    threeHanded();
    setState({ caught: { targetId: CAROL_ID, byId: GUEST_ID, penalty: 4, nonce: 1 } });
    renderApp();

    expect(screen.getByText('אלי תפס/ה את נועה על "אחרון בידי" — נועה לוקח/ת 4 קלפים.')).toBeInTheDocument();
  });

  it('tells the player who was caught who caught them', async () => {
    threeHanded();
    setState({ caught: { targetId: HOST_ID, byId: CAROL_ID, penalty: 4, nonce: 1 } });
    const { user } = renderApp();

    const notice = screen.getByText('נועה תפס/ה אותך על "אחרון בידי" — לקחת 4 קלפים.');
    expect(notice).toBeInTheDocument();
    // An alert, not a status: the player who just lost four cards may not have
    // been looking at the table when it happened.
    expect(notice.closest('[role="alert"]')).not.toBeNull();

    await user.click(within(notice.closest('.callout') as HTMLElement).getByRole('button'));
    expect(useAppStore.getState().caught).toBeNull();
  });

  it('says nothing when nobody has been caught', () => {
    threeHanded();
    renderApp();
    expect(screen.queryByText(/על "אחרון בידי"/)).not.toBeInTheDocument();
  });
});

describe('the connection, in player-friendly words', () => {
  it('explains an offline device rather than blaming the room', () => {
    table({ hand: [red5] });
    // The shell reads `navigator.onLine` on mount, so the browser has to be the
    // one that is offline.
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    renderApp();
    expect(screen.getByText('המכשיר הזה לא מחובר לאינטרנט')).toBeInTheDocument();
    expect(screen.getByText(/המושב שלך נשמר/)).toBeInTheDocument();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('says the seat is being held while reconnecting', () => {
    table({ hand: [red5] });
    setState({ phase: 'reconnecting' });
    renderApp();
    expect(screen.getByText('מתחבר מחדש…')).toBeInTheDocument();
    expect(screen.getByText(/המושב שלך נשמר/)).toBeInTheDocument();
  });
});

describe('leaving', () => {
  it('is one confirmation, wherever the request came from', async () => {
    const leaveRoom = vi.fn();
    table({ hand: [red5] });
    setState({ leaveRoom });
    const { user } = renderApp();

    // The shell owns it, so the top bar, the Back button and the end-of-round
    // screen all go through the same warning with the same wording.
    await user.click(screen.getByRole('button', { name: 'יציאה' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('לצאת מהמשחק?');
    expect(leaveRoom).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'יציאה' }));
    expect(leaveRoom).toHaveBeenCalled();
  });
});

describe('the arming wave', () => {
  it('arms the hand when a playable card is held', () => {
    enterGame({ myTurn: true });
    renderApp();
    expect(document.querySelector('.hand')).toHaveClass('hand--armed');
  });

  it('stays down when nothing can be played', () => {
    enterGame({ myTurn: false });
    renderApp();
    expect(document.querySelector('.hand')).not.toHaveClass('hand--armed');
  });

  it('arms out of turn when an open +3 makes a breaker legal', () => {
    /*
     * The case the cue exists for, and the reason it is not gated on whose turn
     * it is: a +3 suspends the turn order, any holder of a breaker may answer,
     * and the window closes on the first answer. Gating on `isMyTurn` would have
     * left the hand dark at the one moment a player has to decide fastest.
     */
    const fixture = enterGame({ myTurn: false });
    const breaker = { id: 'brk-0', kind: 'breakPlusThree' as const };
    setState({
      hand: [breaker],
      publicState: {
        ...fixture.publicState,
        currentPlayerId: GUEST_ID,
        plusThree: { playerId: GUEST_ID },
      },
    });
    renderApp();

    expect(document.querySelector('.hand')).toHaveClass('hand--armed');
  });

  it('staggers the wave across the hand by position', () => {
    enterGame({ myTurn: true });
    renderApp();
    const slots = [...document.querySelectorAll('.hand__slot')];
    expect(slots.length).toBeGreaterThan(2);
    expect(slots[0]?.getAttribute('style')).toContain('0ms');
    expect(slots[1]?.getAttribute('style')).toContain('25ms');
    expect(slots[2]?.getAttribute('style')).toContain('50ms');
  });
});

describe('the draw pile', () => {
  it('reads as thinning, in four steps', () => {
    expect(depthBucket(45)).toBe(3);
    expect(depthBucket(31)).toBe(3);
    expect(depthBucket(30)).toBe(2);
    expect(depthBucket(16)).toBe(2);
    expect(depthBucket(15)).toBe(1);
    expect(depthBucket(6)).toBe(1);
    expect(depthBucket(5)).toBe(0);
    expect(depthBucket(0)).toBe(0);
  });

  it('wraps the pile without adding a child to the column', () => {
    /*
     * The pile card's size is solved from the height left after `--pile-chrome`,
     * a hand-measured constant declared four times. A fourth child of `.pile`
     * would add a flex gap and make all four wrong at once, so the wrapper has
     * to replace the button rather than sit beside it.
     */
    enterGame({ myTurn: true });
    renderApp();
    const pile = document.querySelector('.pile');
    expect(pile?.children).toHaveLength(3);
    expect(pile?.firstElementChild).toHaveClass('pile__deck');
    expect(pile?.querySelector('.pile__deck > button.card--back')).not.toBeNull();
  });
});

describe('cues driven by the beat', () => {
  it('does not claim a card landed just because the table mounted', () => {
    /*
     * The regression this exists for: the landing animation used to ride on a
     * `key`, so it replayed on any remount — a reconnecting client watched a card
     * land that nobody had played, and so did anyone returning from a background
     * tab.
     */
    enterGame({ myTurn: true });
    renderApp();
    expect(document.querySelector('.discard .card--landing')).toBeNull();
  });

  it('says a card landed when one actually did', () => {
    const fixture = enterGame({ myTurn: true });
    setState({
      beat: {
        seq: 7,
        events: [
          {
            type: 'cardPlayed',
            playerId: GUEST_ID,
            card: fixture.hand[0] as Card,
            resultingColor: 'red',
          },
        ],
      },
    });
    renderApp();
    expect(document.querySelector('.discard .card--landing')).not.toBeNull();
  });

  it('sweeps the seats only when the direction actually changed', () => {
    enterGame({ myTurn: true });
    renderApp();
    expect(document.querySelector('.seats__sweep')).toBeNull();

    setState({
      beat: { seq: 8, events: [{ type: 'directionChanged', direction: -1 }] },
    });
    renderApp();
    expect(document.querySelector('.seats__sweep')).not.toBeNull();
  });

  it('marks a penalty that landed on me, and not one aimed at somebody else', () => {
    enterGame({ myTurn: true });
    setState({
      beat: {
        seq: 9,
        events: [{ type: 'cardDrawn', playerId: GUEST_ID, count: 2 }],
      },
    });
    renderApp();
    expect(document.querySelector('.game__hand--struck')).toBeNull();

    setState({
      beat: {
        seq: 10,
        events: [{ type: 'cardDrawn', playerId: HOST_ID, count: 2 }],
      },
    });
    renderApp();
    expect(document.querySelector('.game__hand--struck')).not.toBeNull();
  });

  it('flashes the ticker on a new line, keyed to the entry', () => {
    enterGame({ myTurn: true });
    renderApp();
    const ticker = document.querySelector('.ticker');
    // The flash is a class the pill always carries; it replays because the pill
    // remounts on a new entry, which is what a `key` buys and a timer would not.
    expect(ticker).toHaveClass('ticker__flash');
  });
});

describe('the flight layer', () => {
  it('mounts over the table and is invisible to assistive technology', () => {
    enterGame({ myTurn: true });
    renderApp();
    const layer = document.querySelector('.flight-layer');
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute('aria-hidden', 'true');
  });

  it('changes nothing about the table when the platform cannot animate', () => {
    /*
     * The regression that matters. jsdom implements no Web Animations API, which
     * is the same situation as a browser that surprises us — and in both the
     * table must be exactly what it would have been with no layer at all, because
     * the layer only ever describes a state the DOM already holds.
     */
    const fixture = enterGame({ myTurn: true });
    renderApp();
    const before = document.querySelector('.hand')?.innerHTML;
    const discardBefore = document.querySelector('.discard')?.innerHTML;

    setState({
      beat: {
        seq: 11,
        events: [
          {
            type: 'cardPlayed',
            playerId: GUEST_ID,
            card: fixture.hand[0] as Card,
            resultingColor: 'red',
          },
        ],
      },
    });

    expect(document.querySelector('.hand')?.innerHTML).toBe(before);
    expect(document.querySelector('.discard')?.innerHTML).toBe(discardBefore);
    // And it leaves nothing behind on the layer either.
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(0);
  });

  it('registers the anchors a flight travels between', () => {
    enterGame({ myTurn: true });
    renderApp();
    // The pile anchors and the hand always exist; a seat exists per opponent, and
    // never for the local player.
    expect(document.querySelector('.pile__deck')).not.toBeNull();
    expect(document.querySelector('.discard')).not.toBeNull();
    expect(document.querySelector('.hand-area')).not.toBeNull();
    expect(document.querySelectorAll('.hand__slot[data-card-id]').length).toBeGreaterThan(0);
  });
});

describe('robots at the table', () => {
  it('marks a robot seat, so nobody thinks they are playing a person', () => {
    // The seat's name comes from the table state; its robot-ness comes from the
    // lobby, which is the only place either fact is published.
    table({
      hand: [red5, red7],
      patch: {
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 2 },
          { id: GUEST_ID, name: 'רובוט 1', cardCount: 5 },
        ],
      },
    });
    setState({
      lobby: lobbyFixture({
        phase: 'inGame',
        players: [
          { id: HOST_ID, name: 'דנה', isCreator: true, health: 'connected', seat: 0 },
          { id: GUEST_ID, name: 'רובוט 1', isCreator: false, health: 'connected', seat: 1, bot: true },
        ],
      }),
    });
    renderApp();
    const seat = screen.getByText('רובוט 1').closest('li');
    expect(seat).not.toBeNull();
    expect(within(seat as HTMLElement).getByText('רובוט')).toBeInTheDocument();
  });

  it('says plainly when a robot is playing somebody else’s hand', () => {
    table({ hand: [red5, red7], myTurn: false });
    setState({
      lobby: lobbyFixture({
        phase: 'inGame',
        sentAt: 1_000_000,
        seatGraceMs: 300_000,
        players: [
          { id: HOST_ID, name: 'דנה', isCreator: true, health: 'connected', seat: 0 },
          {
            id: GUEST_ID,
            name: 'אלי',
            isCreator: false,
            health: 'disconnected',
            seat: 1,
            absentSince: 900_000,
            standIn: true,
          },
        ],
      }),
    });
    renderApp();

    expect(screen.getByText('רובוט משחק במקום אלי')).toBeInTheDocument();
    // And the seat-hold countdown is gone: the table is not waiting for anybody, and
    // saying both at once would contradict what everyone can see happening.
    expect(screen.queryByText(/שומרים את המושב/)).not.toBeInTheDocument();
  });

  it('lets the seat with the lobby buttons hand a covered seat back, and offers others no such control', () => {
    /*
     * Which seat holds the buttons is now read off `creatorPlayerId` in the lobby the
     * room sends, rather than off a local `role` flag — so the two halves of this
     * differ by *who this device is*, which is the thing that actually decides it.
     */
    const THIRD = 'pl_third00000';
    const players = [
      { id: HOST_ID, name: 'דנה', isCreator: true, health: 'connected' as const, seat: 0 },
      {
        id: GUEST_ID,
        name: 'אלי',
        isCreator: false,
        health: 'disconnected' as const,
        seat: 1,
        absentSince: 900_000,
        standIn: true,
      },
      { id: THIRD, name: 'נועה', isCreator: false, health: 'connected' as const, seat: 2 },
    ];
    table({ hand: [red5, red7], myTurn: false });
    setState({ lobby: lobbyFixture({ phase: 'inGame', sentAt: 1_000_000, players }) });
    const first = renderApp();
    expect(screen.getByRole('button', { name: 'עצירת הרובוט' })).toBeInTheDocument();
    first.unmount();

    resetStore();
    table({ hand: [red5, red7], myTurn: false });
    setState({
      inRoom: true,
      localPlayerId: THIRD,
      lobby: lobbyFixture({ phase: 'inGame', sentAt: 1_000_000, players }),
    });
    renderApp();
    expect(screen.getByText('רובוט משחק במקום אלי')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'עצירת הרובוט' })).not.toBeInTheDocument();
  });
});
