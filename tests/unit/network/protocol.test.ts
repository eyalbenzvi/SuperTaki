import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseHostMessage,
  privateHandSchema,
  publicGameStateSchema,
} from '../../../src/features/game/network/protocol.ts';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../../src/features/game/engine/views.ts';
import { players } from '../helpers/engineFixtures.ts';

const ROOM = '482913';

function envelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: 'msg-1',
    roomId: ROOM,
    senderPeerId: 'crush-482913',
    timestamp: 1_700_000_000_000,
    type,
    payload,
    ...overrides,
  };
}

describe('client message validation', () => {
  it('accepts a well-formed join request', () => {
    const result = parseClientMessage(envelope('joinRequest', { displayName: 'Dana' }));
    expect(result.ok).toBe(true);
  });

  it('accepts every action shape', () => {
    for (const action of [
      { type: 'playCard', cardId: 'n-red-5-0' },
      { type: 'playCard', cardId: 'w-colorChange-0', chosenColor: 'green' },
      { type: 'playCard', cardId: 'w-breakPlusThree-0' },
      { type: 'drawCard' },
      { type: 'closeTaki' },
      { type: 'passBreak' },
    ]) {
      expect(parseClientMessage(envelope('action', { action })).ok).toBe(true);
    }
  });

  it.each([
    ['a primitive', 42],
    ['null', null],
    ['an array', [1, 2, 3]],
  ])('rejects %s', (_label, value) => {
    const result = parseClientMessage(value);
    expect(result).toMatchObject({ ok: false, error: 'notAnObject' });
  });

  it('rejects a missing envelope field', () => {
    const message = envelope('joinRequest', { displayName: 'Dana' });
    delete (message as Record<string, unknown>).roomId;
    expect(parseClientMessage(message)).toMatchObject({ ok: false, error: 'malformedEnvelope' });
  });

  it('reports a protocol mismatch instead of a schema error', () => {
    const result = parseClientMessage(
      envelope('joinRequest', { displayName: 'Dana' }, { protocolVersion: PROTOCOL_VERSION + 1 }),
    );
    expect(result).toMatchObject({ ok: false, error: 'protocolMismatch', received: PROTOCOL_VERSION + 1 });
  });

  it('turns away the version before this one, because the rules changed under it', () => {
    // 4 and 5 disagree about whether a King answers a +2 run. A peer on 4 is told
    // to reload rather than seated at a table that would refuse its legal moves.
    const result = parseClientMessage(
      envelope('joinRequest', { displayName: 'Dana' }, { protocolVersion: PROTOCOL_VERSION - 1 }),
    );
    expect(result).toMatchObject({ ok: false, error: 'protocolMismatch', received: PROTOCOL_VERSION - 1 });
  });

  it('rejects an unknown message type', () => {
    const result = parseClientMessage(envelope('takeOverHost', {}));
    expect(result).toMatchObject({ ok: false, error: 'unknownType', received: 'takeOverHost' });
  });

  it('rejects an invalid payload with readable issues', () => {
    const result = parseClientMessage(envelope('joinRequest', { displayName: '' }));
    if (result.ok || result.error !== 'invalidPayload') {
      throw new Error('expected invalidPayload');
    }
    expect(result.issues.join(' ')).toContain('payload.displayName');
  });

  it('rejects an over-long display name', () => {
    const result = parseClientMessage(envelope('joinRequest', { displayName: 'x'.repeat(64) }));
    expect(result).toMatchObject({ ok: false, error: 'invalidPayload' });
  });

  it('rejects an oversized message', () => {
    const result = parseClientMessage(
      envelope(
        'action',
        { action: { type: 'playCard', cardId: 'a' } },
        { id: 'x'.repeat(MAX_MESSAGE_BYTES) },
      ),
    );
    expect(result).toMatchObject({ ok: false, error: 'tooLarge' });
  });

  it('rejects a message that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = envelope('leave', {});
    cyclic.self = cyclic;
    expect(parseClientMessage(cyclic)).toMatchObject({ ok: false, error: 'tooLarge' });
  });

  it('strips unknown extra payload keys instead of trusting them', () => {
    const result = parseClientMessage(
      envelope('joinRequest', { displayName: 'Dana', isHost: true, hand: ['red:1'] }),
    );
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.message.payload).toEqual({ displayName: 'Dana' });
  });

  it('rejects an invalid colour in an action', () => {
    const result = parseClientMessage(
      envelope('action', { action: { type: 'playCard', cardId: 'x', chosenColor: 'purple' } }),
    );
    expect(result).toMatchObject({ ok: false, error: 'invalidPayload' });
  });

  it('rejects a host-only message arriving on the host inbound path', () => {
    const result = parseClientMessage(envelope('publicState', { state: {} }));
    expect(result).toMatchObject({ ok: false, error: 'unknownType' });
  });
});

describe('host message validation', () => {
  const started = createGame(players('Alice', 'Bob'), 99);
  if (!started.ok) {
    throw new Error('fixture failed');
  }
  const publicState = toPublicGameState(started.state);

  it('accepts a real public state snapshot', () => {
    expect(publicGameStateSchema.safeParse(publicState).success).toBe(true);
    const result = parseHostMessage(envelope('publicState', { state: publicState }));
    expect(result.ok).toBe(true);
  });

  it('accepts a real private hand', () => {
    const hand = toPrivateHandView(started.state, 'p-alice');
    expect(privateHandSchema.safeParse(hand).success).toBe(true);
    expect(parseHostMessage(envelope('privateHand', { hand })).ok).toBe(true);
  });

  it('accepts every engine event shape', () => {
    const events = [
      { type: 'gameStarted', firstPlayerId: 'p-alice', activeColor: 'red' },
      {
        type: 'cardPlayed',
        playerId: 'p-alice',
        card: { id: 'n-red-5-0', kind: 'number', color: 'red', value: 5 },
        resultingColor: 'red',
      },
      { type: 'cardDrawn', playerId: 'p-alice', count: 1 },
      { type: 'takiOpened', playerId: 'p-alice', color: 'red', superTaki: false },
      { type: 'takiClosed', playerId: 'p-alice', cardsPlayed: 3 },
      { type: 'colorChosen', playerId: 'p-alice', color: 'blue' },
      { type: 'playerSkipped', playerId: 'p-bob' },
      { type: 'drawStacked', playerId: 'p-alice', total: 4 },
      { type: 'drawRunCancelled', playerId: 'p-bob', cancelled: 4 },
      { type: 'plusThreePlayed', playerId: 'p-alice' },
      { type: 'plusThreeBroken', playerId: 'p-bob', targetId: 'p-alice' },
      { type: 'directionChanged', direction: -1 },
      { type: 'extraTurn', playerId: 'p-alice' },
      { type: 'turnChanged', playerId: 'p-bob' },
      { type: 'drawPileRecycled', count: 12 },
      { type: 'drawPileExhausted' },
      { type: 'playerWon', playerId: 'p-alice' },
    ];
    expect(parseHostMessage(envelope('gameEvents', { version: 3, events })).ok).toBe(true);
  });

  it('rejects a rejection code that is not part of the engine', () => {
    expect(parseHostMessage(envelope('actionRejected', { code: 'because' }))).toMatchObject({
      ok: false,
      error: 'invalidPayload',
    });
  });

  it('rejects a lobby with too many players', () => {
    const lobby = {
      roomCode: ROOM,
      hostPeerId: 'crush-482913',
      hostPlayerId: 'pl_1',
      maxPlayers: 6,
      phase: 'lobby',
      tableLanguage: 'he',
      players: Array.from({ length: 7 }, (_, index) => ({
        id: `pl_${index}`,
        name: `P${index}`,
        isHost: index === 0,
        health: 'connected',
        seat: Math.min(index, 5),
      })),
    };
    expect(parseHostMessage(envelope('lobbyState', { lobby }))).toMatchObject({
      ok: false,
      error: 'invalidPayload',
    });
  });

  it('rejects a public state with a single player', () => {
    const broken = { ...publicState, players: [publicState.players[0]] };
    expect(parseHostMessage(envelope('publicState', { state: broken }))).toMatchObject({
      ok: false,
      error: 'invalidPayload',
    });
  });

  it('rejects a client-only message on the client inbound path', () => {
    expect(parseHostMessage(envelope('joinRequest', { displayName: 'Dana' }))).toMatchObject({
      ok: false,
      error: 'unknownType',
    });
  });

  it('never carries another player hand inside a public snapshot', () => {
    const serialised = JSON.stringify(publicState);
    for (const card of started.state.hands['p-bob'] ?? []) {
      expect(serialised).not.toContain(card.id);
    }
  });
});
