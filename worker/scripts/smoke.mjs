/**
 * End-to-end smoke test against the real worker under `wrangler dev`.
 *
 * Spawns the dev server, drives real WebSocket clients through the whole
 * protocol — registration, claim arbitration, channel handshake, routing,
 * presence, ping/pong — and exits non-zero on the first broken promise.
 * Run with `npm run smoke` from `worker/`.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = 8917;
const BASE = `ws://127.0.0.1:${PORT}`;
const HOST_ID = 'crush-771234';
const HOST_CLAIM = 'a'.repeat(32);

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** A tiny test client: buffered frames, promise-based expectations. */
class Client {
  constructor(room) {
    this.ws = new WebSocket(`${BASE}/v1/room/${room}`);
    this.frames = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener('close', resolve);
    });
    this.ws.addEventListener('message', (event) => {
      const frame =
        typeof event.data === 'string' && event.data.startsWith('{') ? JSON.parse(event.data) : event.data;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        this.frames.push(frame);
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

  send(frame) {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Next frame, buffered or future, within a deadline. */
  next(deadlineMs = 4000) {
    if (this.frames.length > 0) {
      return Promise.resolve(this.frames.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), deadlineMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async expect(check, label) {
    const frame = await this.next().catch(() => fail(`timeout: ${label}`));
    if (!check(frame)) {
      fail(`${label} — got ${JSON.stringify(frame)}`);
    }
    return frame;
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

async function run() {
  // --- host registers ---
  const host = new Client('771234');
  await host.open();
  host.send({ t: 'hello', v: 1, peerId: HOST_ID, claim: HOST_CLAIM });
  await host.expect((f) => f.t === 'welcome' && f.peers.length === 0, 'host welcome');

  // --- ping is answered without involving the room ---
  host.send('ping');
  await host.expect((f) => f === 'pong', 'pong');

  // --- a guest joins, both sides see each other ---
  const guest = new Client('771234');
  await guest.open();
  guest.send({ t: 'hello', v: 1, peerId: 'p-guest1', claim: 'b'.repeat(32) });
  await guest.expect((f) => f.t === 'welcome' && f.peers.includes(HOST_ID), 'guest welcome lists host');
  await host.expect((f) => f.t === 'peerUp' && f.peerId === 'p-guest1', 'host sees peerUp');

  // --- channel handshake and routing, with the server stamping `from` ---
  guest.send({ t: 'open', to: HOST_ID, ch: 'c-1', d: { forged: 'from' }, from: 'somebody-else' });
  await host.expect(
    (f) => f.t === 'open' && f.from === 'p-guest1' && f.ch === 'c-1',
    'open routed, from stamped',
  );
  host.send({ t: 'accept', to: 'p-guest1', ch: 'c-1' });
  await guest.expect((f) => f.t === 'accept' && f.from === HOST_ID, 'accept routed back');
  guest.send({ t: 'msg', to: HOST_ID, ch: 'c-1', d: { move: 'playCard', card: 'red:7' } });
  await host.expect(
    (f) => f.t === 'msg' && f.from === 'p-guest1' && f.d.card === 'red:7',
    'msg carries data',
  );

  // --- a second claim on the host id is denied while the host lives ---
  const intruder = new Client('771234');
  await intruder.open();
  intruder.send({ t: 'hello', v: 1, peerId: HOST_ID, claim: 'c'.repeat(32) });
  await intruder.expect((f) => f.t === 'denied' && f.reason === 'idTaken', 'intruder denied');
  await intruder.closed;

  // --- the host drops; the guest is told; the claim still reclaims the id ---
  host.close();
  await guest.expect((f) => f.t === 'peerDown' && f.peerId === HOST_ID, 'guest sees host down');

  const returning = new Client('771234');
  await returning.open();
  returning.send({ t: 'hello', v: 1, peerId: HOST_ID, claim: HOST_CLAIM });
  await returning.expect(
    (f) => f.t === 'welcome' && f.peers.includes('p-guest1'),
    'returning host reclaims its id and finds the guest still there',
  );
  await guest.expect((f) => f.t === 'peerUp' && f.peerId === HOST_ID, 'guest sees host return');

  // --- routing to somebody absent answers gone ---
  returning.send({ t: 'open', to: 'p-nobody', ch: 'c-9' });
  await returning.expect((f) => f.t === 'gone' && f.peerId === 'p-nobody', 'gone for an absent peer');

  returning.close();
  guest.close();
  console.log('SMOKE PASS: registration, claims, routing, presence, reclaim');
}

// Detached, so the whole process group (npx → wrangler → workerd) can be
// killed at the end; killing only the direct child leaves workerd holding the
// port and this script waiting on its pipes for ever.
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
