/**
 * A real round, over real WebSockets, against the real worker under `wrangler dev`.
 *
 * Everything else in the repository tests the room with something injected: the unit
 * tests give it a `Map` for storage and a clock they control, and the app's tests
 * give it an in-memory pipe. This is the one place where none of that is true — a
 * spawned workerd, an actual Durable Object, actual SQLite, actual sockets — so it is
 * the only test that can catch the mistakes those seams hide: a value that does not
 * survive `JSON` round-tripping through storage, an attachment that does not come
 * back after a wake, a frame the runtime will not carry.
 *
 * It plays a two-player round to a winner, drops one player mid-round and brings
 * them back on their resume token, and exits non-zero on the first broken promise.
 * Run with `npm run smoke` from `worker/`.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = 8917;
const BASE = `ws://127.0.0.1:${PORT}`;
const PROTOCOL_VERSION = 6;

/** Rooms are per-run, so a re-run never meets its own leftovers. */
const ROOM = String(100000 + Math.floor(Math.random() * 900000));

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

let messageCounter = 0;

/** A test client that speaks the game protocol over one socket. */
class Client {
  constructor(label, room = ROOM) {
    this.label = label;
    this.room = room;
    this.ws = new WebSocket(`${BASE}/v1/room/${room}`);
    this.frames = [];
    this.waiters = [];
    /** The latest of each thing the room has told us. */
    this.state = null;
    this.hand = [];
    this.lobby = null;
    this.playerId = null;
    this.resumeToken = null;
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener('close', resolve);
    });
    this.ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data === 'pong') {
        return;
      }
      const frame = JSON.parse(event.data);
      switch (frame.type) {
        case 'joinAccepted':
          this.playerId = frame.payload.playerId;
          this.resumeToken = frame.payload.resumeToken;
          this.lobby = frame.payload.lobby;
          break;
        case 'lobbyState':
          this.lobby = frame.payload.lobby;
          break;
        case 'publicState':
          this.state = frame.payload.state;
          break;
        case 'privateHand':
          this.hand = frame.payload.hand.cards;
          break;
        default:
          break;
      }
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(type, payload) {
    messageCounter += 1;
    this.ws.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id: `m-${messageCounter}`,
        roomId: this.room,
        senderPeerId: this.label,
        timestamp: Date.now(),
        type,
        payload,
      }),
    );
  }

  /** Waits for a frame matching `match`, buffered or future. */
  await(match, label, deadlineMs = 8000) {
    const buffered = this.frames.find(match);
    if (buffered) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        fail(`timeout waiting for ${label} on ${this.label}`);
      }, deadlineMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  awaitType(type, deadlineMs) {
    return this.await((frame) => frame.type === type, type, deadlineMs);
  }

  forget() {
    this.frames.length = 0;
  }

  close() {
    this.ws.close(1000, 'done');
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('wrangler dev never became healthy');
}

/** Cards that must name a colour, and cards that must not. */
const NEEDS_COLOR = new Set(['colorChange', 'superTaki']);

let requestCounter = 0;

/** Sends one intent and waits for the room's answer. Returns whether it was applied. */
async function attempt(client, action) {
  requestCounter += 1;
  const requestId = `rq-${requestCounter}`;
  client.forget();
  client.send('action', { action, requestId });
  const answer = await client.await(
    (frame) =>
      (frame.type === 'actionAccepted' && frame.payload.requestId === requestId) ||
      (frame.type === 'actionRejected' && frame.payload.requestId === requestId),
    `an answer to ${action.type}`,
  );
  return answer.type === 'actionAccepted';
}

/**
 * Makes one legal move for whoever is on turn, by asking.
 *
 * Deliberately not a second implementation of `rules.ts`. A copy of the rules here
 * could disagree with the engine, and then a stalled round would mean "the script is
 * wrong" rather than "the room is wrong" — which is the opposite of what a smoke test
 * is for. So this offers cards until the room accepts one, and falls back to the move
 * that is always available. The refusals are not waste: they exercise the rejection
 * path over a real socket, which nothing else here does.
 */
async function takeTurn(clients) {
  const table = clients[0];
  const onTurn = clients.find((client) => client.playerId === table.state?.currentPlayerId);
  if (!onTurn) {
    fail(`nobody at the table is on turn (${String(table.state?.currentPlayerId)})`);
  }

  // An open +3 freezes every other seat until somebody answers it.
  if (onTurn.state.plusThree !== null) {
    const breaker = onTurn.hand.find((card) => card.kind === 'breakPlusThree');
    if (breaker && (await attempt(onTurn, { type: 'playCard', cardId: breaker.id }))) {
      return;
    }
    await attempt(onTurn, { type: 'passBreak' });
    return;
  }

  for (const card of [...onTurn.hand]) {
    const action = NEEDS_COLOR.has(card.kind)
      ? { type: 'playCard', cardId: card.id, chosenColor: 'red' }
      : { type: 'playCard', cardId: card.id };
    if (await attempt(onTurn, action)) {
      return;
    }
    if (onTurn.state.phase === 'finished') {
      return;
    }
  }

  // Nothing was playable. Inside a sequence of one's own that means closing it —
  // drawing during a Taki is refused, which is the rule the engine enforces.
  if (onTurn.state.takiMode !== null && onTurn.state.takiMode.playerId === onTurn.playerId) {
    await attempt(onTurn, { type: 'closeTaki' });
    return;
  }
  await attempt(onTurn, { type: 'drawCard' });
}

async function run() {
  console.log(`smoke: room ${ROOM}`);

  // --- the creator opens a room ---
  const dana = new Client('dana');
  await dana.open();
  dana.send('joinRequest', {
    displayName: 'Dana',
    create: { maxPlayers: 4, tableLanguage: 'he' },
  });
  await dana.awaitType('joinAccepted');
  if (dana.lobby.creatorPlayerId !== dana.playerId) {
    fail('the creator does not hold the lobby buttons');
  }

  // --- a second attempt to create the same code is refused ---
  const squatter = new Client('squatter');
  await squatter.open();
  squatter.send('joinRequest', {
    displayName: 'Squat',
    create: { maxPlayers: 4, tableLanguage: 'he' },
  });
  const refused = await squatter.awaitType('joinRejected');
  if (refused.payload.reason !== 'roomTaken') {
    fail(`expected roomTaken, got ${refused.payload.reason}`);
  }
  await squatter.closed;

  // --- a guest joins, and both sides see the table ---
  const yoni = new Client('yoni');
  await yoni.open();
  yoni.send('joinRequest', { displayName: 'Yoni' });
  await yoni.awaitType('joinAccepted');
  await dana.await(
    (frame) => frame.type === 'lobbyState' && frame.payload.lobby.players.length === 2,
    'the creator seeing two seats',
  );

  // --- a lobby power from the wrong seat is ignored ---
  yoni.send('roomCommand', { command: { type: 'setMaxPlayers', maxPlayers: 6 } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (dana.lobby.maxPlayers !== 4) {
    fail('a lobby command from a seat without the buttons was honoured');
  }

  // --- the round is dealt ---
  /*
   * Both hands, not one.
   *
   * `broadcastGameState` walks the connections and sends each of them a
   * `publicState` and then a `privateHand`, and a client's hand is filled by its
   * own `privateHand` and nothing else. Waiting on the creator's `publicState`
   * and the guest's `privateHand` therefore said nothing about whether the
   * *creator's* hand had arrived — the two sockets are read independently, and
   * on a loaded machine the guest's frame is processed first often enough to
   * matter. That is the whole of `SMOKE FAIL: expected eight cards each, got 0
   * and 8`: not a deal that went wrong, a check that ran too early.
   */
  dana.send('roomCommand', { command: { type: 'startGame' } });
  await dana.awaitType('publicState');
  await Promise.all([dana.awaitType('privateHand'), yoni.awaitType('privateHand')]);
  if (dana.hand.length !== 8 || yoni.hand.length !== 8) {
    fail(`expected eight cards each, got ${dana.hand.length} and ${yoni.hand.length}`);
  }

  // --- nobody is sent anybody else's cards ---
  const danaIds = new Set(dana.hand.map((card) => card.id));
  for (const card of yoni.hand) {
    if (danaIds.has(card.id)) {
      fail(`both players were dealt ${card.id}`);
    }
  }
  const danaSaw = JSON.stringify(dana.frames);
  for (const card of yoni.hand) {
    if (danaSaw.includes(card.id)) {
      fail(`the creator was sent ${card.id}, which is in the other player's hand`);
    }
  }

  // --- a replayed requestId is answered once, not applied twice ---
  const table = [dana, yoni];
  const first = table.find((client) => client.playerId === dana.state.currentPlayerId);
  first.forget();
  first.send('action', { action: { type: 'drawCard' }, requestId: 'rq-replay' });
  const accepted = await first.await(
    (frame) => frame.type === 'actionAccepted' && frame.payload.requestId === 'rq-replay',
    'the first answer',
  );
  const sizeAfterOnce = first.hand.length;
  first.forget();
  first.send('action', { action: { type: 'drawCard' }, requestId: 'rq-replay' });
  const again = await first.await(
    (frame) => frame.type === 'actionAccepted' && frame.payload.requestId === 'rq-replay',
    'the replayed answer',
  );
  if (again.payload.version !== accepted.payload.version) {
    fail(`a replayed request moved the version: ${accepted.payload.version} → ${again.payload.version}`);
  }
  if (first.hand.length !== sizeAfterOnce) {
    fail('a replayed draw was applied twice');
  }

  // --- a few ordinary moves ---
  for (let move = 0; move < 6; move += 1) {
    if (dana.state.phase === 'finished') break;
    await takeTurn(table);
  }

  // --- one player drops mid-round and comes back on their token ---
  const token = yoni.resumeToken;
  const yoniId = yoni.playerId;
  const handBefore = yoni.hand.map((card) => card.id).join(',');
  const versionBefore = yoni.state.version;
  yoni.close();
  await yoni.closed;
  await dana.await(
    (frame) =>
      frame.type === 'lobbyState' &&
      frame.payload.lobby.players.some((player) => player.id === yoniId && player.health === 'disconnected'),
    'the table noticing a seat go quiet',
  );

  const back = new Client('yoni-again');
  await back.open();
  back.send('resumeRequest', { playerId: yoniId, resumeToken: token });
  await back.awaitType('joinAccepted');
  await back.awaitType('privateHand');
  if (back.playerId !== yoniId) {
    fail('the resumed seat is not the same seat');
  }
  if (back.hand.map((card) => card.id).join(',') !== handBefore) {
    fail('the resumed player did not get their own hand back');
  }
  if (back.state.version < versionBefore) {
    fail('the resumed player was sent a table older than the one they left');
  }

  // --- a wrong token is refused ---
  const forger = new Client('forger');
  await forger.open();
  forger.send('resumeRequest', { playerId: yoniId, resumeToken: 'f'.repeat(32) });
  const denied = await forger.awaitType('joinRejected');
  if (denied.payload.reason !== 'invalidResumeToken') {
    fail(`expected invalidResumeToken, got ${denied.payload.reason}`);
  }
  await forger.closed;

  // --- and the round is played out to a winner ---
  const seated = [dana, back];
  for (let move = 0; move < 400; move += 1) {
    if (dana.state.phase === 'finished') break;
    await takeTurn(seated);
  }
  if (dana.state.phase !== 'finished') {
    fail(`the round never ended (${dana.state.players.map((p) => p.cardCount).join('/')} cards left)`);
  }
  if (dana.state.winnerId === null) {
    fail('the round finished with no winner');
  }
  await dana.await(
    (frame) => frame.type === 'lobbyState' && frame.payload.lobby.phase === 'finished',
    'the lobby reaching the standings',
  );

  dana.close();
  back.close();
  console.log(
    'SMOKE PASS: create, collision, join, authorisation, deal, privacy, replay dedup, drop and resume, a winner',
  );
}

// Detached, so the whole process group (npx → wrangler → workerd) can be killed at
// the end; killing only the direct child leaves workerd holding the port and this
// script waiting on its pipes for ever.
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
let serverLog = '';
wrangler.stdout.on('data', (chunk) => {
  serverLog += String(chunk);
});
wrangler.stderr.on('data', (chunk) => {
  serverLog += String(chunk);
});

try {
  await waitForServer();
  await run();
} catch (error) {
  console.error(error.message ?? error);
  console.error('--- wrangler output tail ---');
  console.error(serverLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-wrangler.pid, 'SIGTERM');
  } catch {
    wrangler.kill('SIGTERM');
  }
  // The verdict is printed; nothing left to wait for.
  process.exit(process.exitCode ?? 0);
}
