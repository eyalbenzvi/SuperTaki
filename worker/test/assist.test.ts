/**
 * The easements, as the room runs them.
 *
 * Two questions, and the first one is the whole feature: does the table ever tell
 * anybody? Everything else — the refusals, the persistence, the longer window — is
 * ordinary behaviour that happens to be about children.
 */

import { describe, expect, it } from 'vitest';
import { Harness, type TestClient } from './harness.ts';
import { readRoom } from '../src/storage.ts';
import { LAST_CARD_GRACE_MS, catchGraceMs } from '../../src/features/game/network/timing.ts';

const CREATE = { create: { maxPlayers: 4, tableLanguage: 'he' as const } };

/** A room with a creator and two other seats, still in its lobby. */
function lobby(options?: ConstructorParameters<typeof Harness>[0]) {
  const table = new Harness(options);
  const creator = table.join('Dana', CREATE);
  const child = table.join('Yoni');
  const other = table.join('Noa');
  return { table, creator, child, other };
}

function settingsOf(client: TestClient) {
  return client.last('assistState')?.payload.settings;
}

describe('who is told', () => {
  it('sends the list to the seat holding the buttons and to nobody else', () => {
    const { creator, child, other } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'medium', playerIds: [child.playerId] },
    });

    expect(settingsOf(creator.client)).toEqual({ level: 'medium', playerIds: [child.playerId] });
    expect(settingsOf(child.client)).toBeUndefined();
    expect(settingsOf(other.client)).toBeUndefined();
  });

  it('never puts it in the lobby snapshot, which everybody receives', () => {
    const { creator, child } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'strong', playerIds: [child.playerId] },
    });
    for (const snapshot of child.client.all('lobbyState')) {
      expect(JSON.stringify(snapshot.payload.lobby)).not.toContain('assist');
    }
  });

  it('never names a marked seat in a single byte sent to anybody else', () => {
    /*
     * The bytes rather than the model, because that is the actual promise: a child
     * with the developer tools open on their own phone must find nothing about who is
     * being helped. Their own catch delay is there and is deliberately allowed — it
     * is a number about themselves and names nobody.
     */
    const { table, creator, child, other } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'strong', playerIds: [child.playerId] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.advance(1_000);

    for (const client of [child.client, other.client]) {
      for (const frame of client.rawFrames) {
        expect(frame).not.toContain('"settings"');
        expect(frame).not.toContain('"level"');
      }
    }
    // And the marked seat is not told it is marked, either.
    expect(settingsOf(child.client)).toBeUndefined();
  });

  it('follows the buttons when the creator leaves the room', () => {
    const { table, creator, child, other } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'light', playerIds: [child.playerId] },
    });
    child.client.forget();
    other.client.forget();
    creator.client.say('leave', {});
    table.advance(1_000);

    // The lowest-numbered remaining seat holds the buttons now, so it holds the list.
    expect(settingsOf(child.client)).toEqual({ level: 'light', playerIds: [child.playerId] });
    expect(settingsOf(other.client)).toBeUndefined();
  });
});

describe('what the room refuses', () => {
  it('leaves at least one seat playing the ordinary game, even when asked for all of them', () => {
    /*
     * Which is not a check so much as a consequence: the seat holding the buttons is
     * never eligible, so somebody is always unmarked however the list is asked for.
     * That is also the case the feature is actually for — one adult and two children,
     * where marking both children is exactly right and marking the adult is not a
     * thing anybody meant.
     */
    const { creator, child, other } = lobby();
    creator.client.say('roomCommand', {
      command: {
        type: 'setAssist',
        level: 'strong',
        playerIds: [creator.playerId, child.playerId, other.playerId],
      },
    });
    expect(settingsOf(creator.client)).toEqual({
      level: 'strong',
      playerIds: [child.playerId, other.playerId],
    });
  });

  it('drops the seat that is doing the asking', () => {
    const { creator, child } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'medium', playerIds: [creator.playerId, child.playerId] },
    });
    expect(settingsOf(creator.client)).toEqual({ level: 'medium', playerIds: [child.playerId] });
  });

  it('ignores a robot, which has no evening to spoil', () => {
    const { table, creator, child } = lobby();
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    void table;
    const robotId = creator.client.lobby?.players.find((player) => player.bot === true)?.id;
    expect(robotId).toBeDefined();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'strong', playerIds: [robotId as string, child.playerId] },
    });
    expect(settingsOf(creator.client)).toEqual({ level: 'strong', playerIds: [child.playerId] });
  });

  it('takes it from nobody but the seat holding the buttons', () => {
    const { creator, child, other } = lobby();
    child.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'strong', playerIds: [other.playerId] },
    });
    expect(settingsOf(creator.client)).toEqual({ level: 'off', playerIds: [] });
  });

  it('refuses to change it once the cards are dealt', () => {
    const { creator, child, other } = lobby();
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    creator.client.forget();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'strong', playerIds: [child.playerId] },
    });
    void other;
    expect(creator.client.last('assistState')).toBeUndefined();
  });
});

describe('what the round remembers', () => {
  it('bakes the weights into the deal and keeps the setting for the next one', () => {
    const { table, creator, child } = lobby();
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'medium', playerIds: [child.playerId] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });

    const record = readRoom(table.store);
    expect(record.ok && record.value.assist).toEqual({
      level: 'medium',
      playerIds: [child.playerId],
    });
  });

  it('reloads a record written before any of this existed', () => {
    // The rule this schema lives by: an older record comes back as a table that
    // leans towards nobody, rather than being thrown away with every seat in it.
    const { table } = lobby();
    const raw = JSON.parse(table.store.get('room') as string) as Record<string, unknown>;
    delete raw.assist;
    table.store.put('room', JSON.stringify(raw));

    const record = readRoom(table.store);
    expect(record.ok).toBe(true);
    expect(record.ok && record.value.assist).toEqual({ level: 'off', playerIds: [] });
  });
});

describe('the head start on a last card', () => {
  it('lasts longer for a marked seat than the ordinary window', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const child = table.join('Yoni');
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'medium', playerIds: [child.playerId] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.forceHandForTests(child.playerId, 1);

    // Past the window everybody else gets, and still protected.
    table.advance(LAST_CARD_GRACE_MS + 50);
    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: child.playerId },
      requestId: 'rq-early',
    });
    expect(creator.client.expect('actionRejected').payload.code).toBe('nothingToCatch');

    // Past their window too: a silent player is still a silent player.
    table.advance(catchGraceMs(2, 0));
    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: child.playerId },
      requestId: 'rq-late',
    });
    expect(creator.client.expect('actionAccepted').payload.requestId).toBe('rq-late');
  });

  it('is waived entirely for a marked seat doing the catching', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const child = table.join('Yoni');
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'light', playerIds: [child.playerId] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.forceHandForTests(creator.playerId, 1);

    child.client.forget();
    child.client.say('action', {
      action: { type: 'catchLastCard', targetId: creator.playerId },
      requestId: 'rq-now',
    });
    expect(child.client.expect('actionAccepted').payload.requestId).toBe('rq-now');
  });

  it('tells each player how long their own button waits, and nothing else', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const child = table.join('Yoni');
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'light', playerIds: [child.playerId] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });

    expect(child.client.expect('assistState').payload.catchDelayMs).toBe(0);
    expect(creator.client.expect('assistState').payload.catchDelayMs).toBe(LAST_CARD_GRACE_MS);
  });
});

describe('an ordinary table', () => {
  it('is dealt exactly the round it would have been dealt', () => {
    const plain = new Harness({ seed: 4242 });
    plain.join('Dana', CREATE).client.say('roomCommand', { command: { type: 'startGame' } });
    const untouched = new Harness({ seed: 4242 });
    const creator = untouched.join('Dana', CREATE);
    untouched.join('Yoni');
    creator.client.say('roomCommand', {
      command: { type: 'setAssist', level: 'off', playerIds: [] },
    });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(settingsOf(creator.client)).toEqual({ level: 'off', playerIds: [] });
    expect(creator.client.state?.players.every((player) => player.cardCount === 8)).toBe(true);
  });
});
