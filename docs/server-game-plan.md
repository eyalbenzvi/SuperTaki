# Moving the game onto the server

Status: plan, written before the code. The companion documents are
`docs/architecture.md` (what the system is), `docs/protocol.md` (the wire
contract), `docs/rules.md` (the rules contract), `docs/resilience-plan.md`
(where the timing rules and their rationales come from) and
`docs/threat-model.md` (what we are and are not defending).

---

## 1. Why

Super Taki works today, and the thing that makes it work is also the thing that
makes it fragile: **the room creator's browser tab is the game.** `hostSession.ts`
holds the only complete `GameState`, validates every move, deals every hand, and
runs every timer. Everyone else is a client of a phone in somebody's pocket.

Everything difficult in the current codebase exists to paper over that one fact:

| Apparatus                                                                  | Exists because                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------- |
| `hostSnapshot.ts` — the whole game state in `localStorage`                 | the authority can be closed by the OS at any moment   |
| room-code reclaim, relay claims, `HOST_ID_RETRY_SCHEDULE_MS`               | the returning host has to prove it is the same host   |
| `HostResumeCard`, `resumeHosting()`                                        | somebody has to press a button to bring the game back |
| voluntary handover (`handoffOffer` / `handoffAccepted` / host generations) | the host wants to leave and the round should not die  |
| `hostClosed(restarting)`, `announceRestarting()`, `pagehide` hooks         | a reload has to be told apart from a goodbye          |
| `HOST_SELF_DEMOTE_MS`, `signalling` health on the host's own seat          | the authority can be half-alive                       |
| `closed.hostLeft`: _"the game cannot continue without the host"_           | it genuinely could not                                |

That is roughly 3,500 lines of client code and one apologetic sentence in the UI,
all in service of a topology we no longer need. The relay is already a Durable
Object with SQLite storage, one instance per room code, addressed by
`idFromName(code)`. Every player already has a WebSocket to it. **The authority
should live there.**

Then: the room creator is an ordinary player. Anybody can lose their phone, close
their tab, or vanish for an hour, and the table is exactly where they left it.

---

## 2. Decision 1 — the DO speaks the existing game protocol

**Decision: keep `src/features/game/network/protocol.ts` as the room's language,
and delete the relay's peer-routing layer underneath it.**

Today there are two protocols stacked on one socket:

```
┌─ game protocol (protocol.ts, Zod, version 5) ── joinRequest, action, publicState, …
└─ relay protocol (relayProtocol.ts / worker/src/protocol.ts, version 1)
      hello + claim, open/accept/msg/close on channel `ch`, peerUp/peerDown/gone
```

The lower layer's entire job is _routing between named peers_. Once the room
itself is the authority there is exactly one destination — the room — so routing
has nothing left to decide. Keeping it would mean the Durable Object pretending
to be a peer inside its own room: an extra handshake, a second id space, and a
claim system defending an id nobody can contend for.

So the two layers collapse into one. **The socket is the session.** A client
opens `wss://…/v1/room/<six digits>` and immediately sends a `joinRequest` or
`resumeRequest` envelope; the room answers with the same host messages
`clientSession.ts` already knows how to read.

### The alternative, and why not

A redesigned protocol was seriously considered — something binary-ish and
delta-based, with the room pushing only what changed.

Against it:

- `protocol.ts` is 550 lines of Zod that has already survived five versions and
  a resilience programme. Its comments record _why_ each field is shaped the way
  it is (`turnToken` is not checked for out-of-turn moves; `absentSince` is an
  absolute host clock rather than a duration; `actionAccepted` exists because
  acknowledgement cannot be inferred from state moving). Rewriting it means
  re-learning all of that in production.
- `clientSession.ts` is an existing, tested implementation of exactly the half we
  need to keep. Reusing it turns "rewrite the client" into "delete the host from
  the client".
- The payloads are already small. A public snapshot for six players is under 2 KB;
  a private hand is a few hundred bytes. Deltas would buy nothing measurable and
  cost a reconciliation bug surface that snapshots do not have.
- The invariant tests that prove no hand leaks into a public payload are written
  against `toPublicGameState`. Keeping the shape keeps the tests, now pointed at
  server output.

For it: nothing that survived contact with the above. **Reuse it.**

### What does change in the protocol — version 6

`PROTOCOL_VERSION` goes to 6, `SUPPORTED_PROTOCOL_VERSIONS` becomes `[6]`. There
are no live users and the task calls for a hard cutover, so there are no shims.

Removed, because the concept is gone:

- `LobbySnapshot.hostPeerId` — there is no host peer.
- `LobbySnapshot.generation` — host generations existed only for handover.
- `handoffOffer`, `handoffAccepted` — the room does not move.
- `hostClosed` reasons `restarting` and `handoff`; the message shrinks to
  `roomClosed { reason: 'roomClosed' }`. (`roomReset` was in this plan and was built,
  and then deleted — nothing ever produced it.)
- `ConnectionHealth`'s `'unstable'` (see §5) — a socket is open or it is not.

Kept, with its meaning narrowed:

- `LobbySnapshot.hostPlayerId` → renamed `creatorPlayerId`. It still names one
  seat, and that seat still has lobby powers; it no longer names an authority.
- `envelope.senderPeerId` stays on the wire but now identifies a _connection_,
  not a routable peer. The room stamps `'room'`. Renaming it would ripple through
  `envelope.ts`, both sessions and every test fixture to buy a better word.

Added, because these were method calls on a local object and are now messages:

```ts
message('roomCommand', z.object({ command: roomCommandSchema }));
```

with `roomCommandSchema` a discriminated union of `startGame`, `setMaxPlayers`,
`setTableLanguage`, `kickPlayer`, `addBot`, `setStandInEnabled`, `standInNow`,
`stopStandIn`, `skipAbsentTurn`, `removeFromRound`. One message type rather than
ten keeps the top-level union readable and the authorisation check in one place.

### The creator credential

The requirement is that the room creator keeps _only_ lobby powers, via a
credential.

**Decision: the creator credential is the creator seat's resume token.** The room
records `creatorPlayerId`; a `roomCommand` is authorised if and only if it
arrives on a connection the room has already bound to that seat — and a
connection is bound to a seat by presenting its resume token.

A second secret was considered and rejected: it would be one more thing to
persist, one more thing to lose, and it would grant exactly the set of powers the
resume token already grants. What matters is that creator authority is _a
credential a device holds_ rather than _whoever happens to be serving_, and the
resume token already is that.

One sharp edge the old design did not have: the creator's seat can now be swept
(lobby grace) or leave. If `creatorPlayerId` names no seat, powers pass to the
lowest-numbered remaining seat, so a room can always be started. Recorded in the
lobby snapshot, so every screen agrees about who has the buttons.

### Room creation and code collisions

Today the host _claims_ a peer id derived from the room code, and the relay
answers `idTaken` on a collision. There is no id to claim any more, so:

`joinRequest` gains `create?: { maxPlayers, tableLanguage }`. The room accepts it
only when it has no seats yet; otherwise `joinRejected('roomTaken')` and the
client draws another six digits. Same four attempts, same user-visible behaviour,
one fewer secret.

---

## 3. Decision 2 — how the engine is shared

The engine (`src/features/game/engine/`) is pure TypeScript with no dependencies,
no DOM and no network. It must run unchanged in the worker bundle, and its unit
tests must keep passing untouched.

**Decision: plain relative imports from `worker/src/` into
`../../src/features/game/…`, with the worker's `tsconfig.json` extended to
include those files.**

```jsonc
// worker/tsconfig.json
"include": [
  "src/**/*.ts",
  "test/**/*.ts",
  "../src/features/game/engine/**/*.ts",
  "../src/features/game/bot/**/*.ts",
  "../src/features/game/network/protocol.ts",
  "../src/features/game/network/envelope.ts",
  "../src/features/game/network/timing.ts",
  "../src/lib/{id,sanitize}.ts"
]
```

Considered and rejected:

- **A symlink** (`worker/src/engine → ../../src/features/game/engine`). Breaks on
  Windows checkouts and is invisible in a diff.
- **An npm workspace package.** Correct in the abstract; in practice it means a
  third `package.json`, a build step for the shared package or `exports` juggling
  with `.ts` sources, and a second lockfile to keep honest. The engine has no
  dependencies — the packaging would be pure ceremony.
- **Copying the files** (as `relayProtocol.ts` copies the relay protocol today).
  That copy is 90 lines of frozen constants; the engine is 2,500 lines of live
  rules. A copy would drift, and drift here means two peers disagreeing about
  which cards are legal.

esbuild (via `wrangler`) follows relative imports out of the worker directory
without configuration. Both tsconfigs then typecheck the same files, which is the
property that actually matters: a change to the engine that breaks the worker
fails `npm run typecheck` _and_ `cd worker && npm run verify`.

The app's `zod` is the one dependency that travels: `protocol.ts` needs it. The
worker gains `zod` as a dependency at the same version. It is ~60 KB minified
into a bundle whose free-plan ceiling is 3 MB, and it is already configured
`jitless` for the browser's CSP — which is also the right setting for workerd,
where `new Function` is unavailable.

**Nothing in `src/features/game/engine/` changes.** One additive change is needed
outside it: `BotRunner` gains a public `pump()` (see §5), because a robot's think
pause becomes an alarm and an alarm cannot resume a closure.

---

## 4. Server state and storage

### Shape

The Durable Object's SQLite storage holds three things:

```sql
-- The room record and the game state, each a single validated JSON blob.
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
--   k = 'room'  → RoomRecord   (seats, phase, votes, creator, rng streams …)
--   k = 'game'  → GameState    (hands, deck order, RngState, version, turnSeq)

-- The alarm multiplexer's queue: one row per pending deadline.
CREATE TABLE IF NOT EXISTS alarms (kind TEXT PRIMARY KEY, at INTEGER NOT NULL);
```

`RoomRecord` carries everything the old `HostRestoreState` carried, plus what the
host used to keep in memory and lose on a restart:

```ts
interface RoomRecord {
  roomCode: string;
  creatorPlayerId: string;
  phase: 'lobby' | 'inGame' | 'finished';
  maxPlayers: number;
  tableLanguage: 'he' | 'en';
  versionFloor: number; // highest version ever broadcast
  round: number; // rounds dealt, so the first seat rotates
  standInEnabled: boolean;
  pausedBy: string | null;
  waitingSince: number | null;
  playAgainVotes: string[];
  abandonVotes: string[];
  lastCardSince: Record<PlayerId, number>; // was in-memory on the host
  botRng: Record<PlayerId, number>; // was in-memory on the host
  seats: SeatRecord[]; // playerId, name, seat, resumeToken, left, bot,
  // absentSince, lastIntentAt, lastResumeAttemptAt,
  // standIn, standInDeclined, saidGoodbye,
  // skippedWhileAway, robotPlayedThisRound,
  // lastRequestId, lastRequestVersion
}
```

### Why blobs rather than tables

The room record is at most six seats and is always read and written _whole_ — no
query ever wants one seat. It already needs a Zod schema for validate-on-read, and
that schema is a better description of the shape than a set of columns would be.
Hands and deck order have to be a blob regardless: their _order_ is the state.
Normalising would add migration surface and buy no query we want to run.

One `INSERT OR REPLACE` per accepted command, on a table with two rows. Free tier
throughout.

### Validate on read

Every read goes through Zod. A row that does not parse is treated as _no room_:
logged, dropped, and the connection answered `joinRejected('roomClosed')` rather
than served state nobody can reason about. Storage written by a previous version
of the worker is exactly the case this catches, and silently half-parsing it is
how a table ends up in a state the engine has no transition out of.

### Surviving hibernation and eviction

Nothing lives only in memory. The DO's in-memory `GameRoom` is a _cache_, rebuilt
by `ensureRoom()` from storage on any wake — the same pattern `room.ts` already
uses for `RoomCore`, extended from claims to the whole game:

- **Live sockets** come back from `ctx.getWebSockets()`, each re-identified from
  its serialized attachment (`{ playerId }`, written once when its join is
  accepted).
- **Everything else** comes back from `kv`.
- `setWebSocketAutoResponse('ping','pong')` stays: the runtime answers liveness
  probes without waking the object, which is what keeps an idle room free.

---

## 5. Decision 3 — timers become one alarm, multiplexed

A Durable Object has exactly one alarm. The host had a 5–15 s heartbeat that
swept everything on every tick; that shape is wrong here twice over — it would
wake the object hundreds of times a round (defeating hibernation, which is the
whole zero-cost story) and it was only a _polling_ approximation of deadlines
that are known exactly.

### The multiplexer

```ts
type AlarmKind =
  | 'absentTurn' // pass the turn of a seat that is not there
  | 'botMove' // a robot's think pause is over
  | 'botStall' // a robot did not move; pass the seat
  | 'standIn' // a seat has been away long enough for a robot to take it
  | 'lastCard' // a last-card head start has expired
  | 'idleNudge' // re-broadcast the lobby so the nudge appears
  | 'seatGrace' // a held seat's grace has run out
  | 'ttl'; // forget an empty room

class AlarmMux {
  set(kind: AlarmKind, atMs: number): void; // upsert
  clear(kind: AlarmKind): void;
  due(nowMs: number): AlarmKind[]; // reads + deletes, in rank order
  private rearm(): void; // storage.setAlarm(min) | deleteAlarm()
}
```

`set`/`clear` write the `alarms` row and then re-arm the single platform alarm to
the earliest remaining deadline. `alarm()` collects everything due, deletes those
rows, runs the handlers in a fixed rank order, and re-arms from what is left plus
anything the handlers scheduled.

Rank order is part of the contract, not an accident: `absentTurn` outranks
`botMove` (a seat nobody is in must not wait behind a robot's pause), and
`standIn` outranks both (if a robot is about to take the seat, it should take it
before the seat is skipped again).

### Preserving what players see

The timing rules in `src/features/game/network/timing.ts` and their rationales in
`docs/resilience-plan.md` are the contract. The behaviours are preserved; the
_mechanism_ changes from polling to exact deadlines.

| Behaviour                                 | Constant                                                | Old mechanism                                               | New mechanism                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent seat's turn is passed              | `ABSENT_TURN_GRACE_CLOSED_MS` (12 s)                    | swept on each heartbeat tick                                | `absentTurn` alarm, armed when a seat goes absent or the turn reaches an absent seat                                                                |
| a rejoin attempt calls off a pending skip | `RESUME_ATTEMPT_SUPPRESSES_SKIP_MS` (20 s)              | flag read by the sweep                                      | `resumeRequest` pushes the `absentTurn` alarm out                                                                                                   |
| last-card head start                      | `LAST_CARD_GRACE_MS` (30 ms)                            | clock comparison per catch                                  | unchanged — still a comparison against `lastCardSince`; the `lastCard` alarm only exists so a _robot's_ catch is re-evaluated when the window shuts |
| idle-turn nudge appears                   | `IDLE_TURN_NUDGE_MS` (30 s)                             | one extra lobby broadcast when a tick crossed the threshold | `idleNudge` alarm at exactly the threshold                                                                                                          |
| seat held mid-game                        | `SEAT_GRACE_MS` (5 min)                                 | compared when a round ended                                 | `seatGrace` alarm; the number still travels in the snapshot so the client derives its own deadline                                                  |
| lobby seat freed                          | `LOBBY_GRACE_MS` (30 s)                                 | swept on each tick                                          | `seatGrace` alarm                                                                                                                                   |
| robot pauses                              | `BOT_*_MS`                                              | `setTimeout` in `BotRunner`                                 | `botMove` alarm; `BotRunner.pump()` re-decides on fire                                                                                              |
| robot did not move                        | `BOT_STALL_MS` (15 s)                                   | swept on each tick                                          | `botStall` alarm                                                                                                                                    |
| robot covers an away seat                 | `STAND_IN_ABSENT_MS` (45 s) / `STAND_IN_IDLE_MS` (90 s) | swept on each tick                                          | `standIn` alarm                                                                                                                                     |
| pause                                     | —                                                       | suppressed the sweeps                                       | clears the alarms it should suppress; re-arms them on resume                                                                                        |
| room forgotten                            | `ROOM_IDLE_TTL_MS` (6 h)                                | already an alarm                                            | `ttl` kind in the mux                                                                                                                               |

`BotRunner` needs one additive change. Its `schedule` seam hands back a cancel
function and calls a _closure_ when the pause is over; a closure cannot survive
hibernation. So the server's `schedule` records a `botMove` deadline and returns a
cancel that clears it, and the alarm handler calls a new public `pump()` — which
is the existing private `fire()`, promoted. `fire()` becomes a one-line caller of
it, so the runner's own tests are unaffected.

### What disappears, and why that is honest

The host inferred presence from probe accounting: ping nonces, `ProbeTracker`,
`UNSTABLE_AFTER_MISSES`, `silentAfterMs`, `CHANNEL_DEAD_MS`, late-tick forgiveness,
and a whole `'unstable'` health state that meant "we are not sure".

The Durable Object does not have to guess. `webSocketClose` is the runtime telling
it, reliably, that a seat's socket is gone. So:

- **Seat health becomes socket liveness**: `connected` or `disconnected`. The
  `'unstable'` state and `ABSENT_TURN_GRACE_UNSTABLE_MS` go with it.
- The server-side heartbeat goes entirely. `ping`/`pong` stay in the protocol for
  the _client's_ benefit: a phone coming out of sleep genuinely cannot tell a live
  socket from a half-open one, and that is a real problem the client still owns.
- `HOST_SELF_DEMOTE_MS`, `HANDOFF_TIMEOUT_MS`, `HOST_ID_RETRY_SCHEDULE_MS` and
  `SIGNALLING_READY_MS` lose their subjects and are deleted.

This is the single largest simplification in the change, and it comes from
replacing an inference with an observation.

---

## 6. Privacy

The invariant is unchanged: **each player receives only their own hand plus public
state (card counts).** `toPublicGameState` already excludes every card identity
except the visible discard top, and `toPrivateHandView` is per player. Both move
to the server unchanged.

The existing invariant tests move with them, and get stronger: instead of
asserting a projection is clean, they drive a whole round through the server core
and assert that **no card id from any player's hand ever appears in any frame sent
to any other player**. That is the property we actually care about, and it can only
be tested where the frames are.

`docs/threat-model.md` has to become honest about what moved. Previously every
hand existed only in the room creator's browser — a device belonging to somebody
who was already entitled to see the discard pile and their own cards, and who
could always have read the rest out of their own memory. Now every hand exists in
a Durable Object for the lifetime of the room (deleted on the 6 h idle TTL, or
when the room is reset).

What that does and does not mean:

- **Players still cannot see each other's hands.** The projection is enforced
  server-side, which is strictly stronger than before: a modified client used to
  be able to see everything if it was the host, and can now see nothing extra.
- **Cheating by inspecting the authority is no longer possible for a player.**
  This is a real security improvement and the threat model should say so.
- **The operator can, in principle, read hands** — whoever holds the Cloudflare
  account can attach `wrangler tail` or inspect the object. The operator is the
  repository owner, the game has no stakes, and the alternative (encrypting hands
  under a key the server does not hold) is incompatible with the server being the
  rules authority. Stated plainly rather than waved at.
- **Retention is bounded and mechanical**: `storage.deleteAll()` on the TTL alarm.

---

## 7. What gets deleted

Client, in full:

| File                                                 | Lines | Why                                                             |
| ---------------------------------------------------- | ----- | --------------------------------------------------------------- |
| `src/features/game/network/hostSession.ts`           | 2,600 | the authority moved                                             |
| `src/features/game/state/hostSnapshot.ts`            | 321   | nothing to snapshot locally                                     |
| `src/features/game/ui/components/HostResumeCard.tsx` | ~90   | nothing to resume                                               |
| `src/features/game/network/relayProtocol.ts`         | 97    | the routing layer is gone                                       |
| `src/features/game/network/memoryTransport.ts`       | 299   | replaced by an in-memory room socket pair                       |
| `src/features/game/network/broadcastTransport.ts`    | 262   | see the decision below                                          |
| `src/features/game/network/relayTransport.ts`        | 751   | replaced by `roomTransport.ts` (~400, no channels/claims/peers) |

Client, in part:

- `store.ts` — `resumeHosting`, `hostable`, `handOver`, `acceptHandoff`,
  `persistHostedRoom`, `attachSleepHook`, `activeRoomClaim`, the `HostSession`
  branch of every action, and the `instanceof` forks throughout. One session type.
- `clientSession.ts` — `hostPeerId`, `handoffOffer`, `hostClosed(restarting|handoff)`.
- `roomCode.ts` — `hostPeerIdForRoom`, `roomCodeFromHostPeerId`, host generations,
  `InviteDetails.hostPeerId`, and the `host=` invite parameter.
- `persistence.ts` — `ResumableRoom.hostPeerId` and `.generation`.
- `session.ts` — `handover` / `handoffOffer` updates, `hostPeerId` on `Session`,
  `TransportErrorCode`'s WebRTC-era members (`idUnavailable`, `peerUnavailable`,
  `signalingUnavailable`, `browserUnsupported`).
- `timing.ts` — the six constants listed at the end of §5.
- i18n (`he` + `en`) — `host.resume*`, `host.reclaiming`, `host.restarting`,
  `host.selfDemoted`, `host.handoff*`, `closed.restarting`, `closed.handoff`, and
  the honest rewrite of `closed.hostLeft`, whose current text —
  _"under this server-free design the game cannot continue without the host"_ — is
  now false.
- Tests: `tests/unit/state/hostSnapshot.test.ts` in full; the host halves of
  `sessions.test.ts`, `resilience.test.ts`, `bots.test.ts`, `storeFlow.test.ts`.
  What they proved about the _game_ moves to the worker's own tests, where the
  game now is.

Worker:

- `worker/src/roomCore.ts` — claim arbitration and frame routing. The name
  `RoomCore` and its pattern (inject sockets, storage and a clock; test in plain
  Node) carry over to the new `GameRoom`.
- `worker/src/protocol.ts` shrinks to socket-level concerns: the room-code
  pattern, the frame-size ceiling, the idle TTL. `RELAY_PROTOCOL_VERSION` and
  `CLAIM_HOLD_MS` go — there is one protocol version now, the game's, and one
  place that gates it.

### The BroadcastChannel transport

**Decision: remove it.**

It exists for two reasons, and both have expired. It let the e2e suite play a real
multiplayer game without a signalling server — but the e2e suite is moving onto
the real worker under `wrangler dev`, precisely so CI exercises the production
path instead of a lookalike. And it was offered as "same-device play" via
`?transport=broadcast`, which is not a documented feature, not reachable from the
UI, and not something any player has ever needed: two tabs on one machine can
simply both join the room.

Keeping it would mean maintaining a second transport with different semantics
(no server, no authority, no persistence) that no user path and no test uses. The
`?transport=` parameter and its invite-URL carry-over go with it.

---

## 8. The client after the change

```
roomTransport.ts     one WebSocket to /v1/room/<code>; JSON envelopes in and out;
  (~400 lines)       backoff, jitter, wake-triggered reconnect, ping/pong probe
                     for the half-open case. No channels, no claims, no peers.
clientSession.ts     unchanged in shape: connect → join/resume → apply what the
  (~800 lines)       room confirms. Loses hostPeerId and the handover paths.
store.ts             one session type. `createRoom` connects with
  (~900 lines)       `joinRequest{create}`; creator powers send `roomCommand`.
```

UI flow is untouched: create room → share code/link/QR → play. Hebrew default,
English available. No new screens. The only visible change is that "waiting for
the host" language becomes obsolete — everyone reconnects to _the room_, and the
one sentence that told players the game dies with the host is deleted because it
is no longer true. `ResumeCard` stays and now covers every player equally,
including whoever created the room.

---

## 9. Testing

`GameRoom` follows `RoomCore`'s existing pattern: sockets, storage and the clock
are injected, so it runs in plain Node with no workerd. The storage seam is a
`RoomStore` interface (`get`/`put`/`delete`), backed by SQLite in the DO and by a
`Map` in tests — the same trick `ClaimStore` uses today.

`worker/test/gameRoom.test.ts` must cover, at minimum:

- join, and rejoin with a resume token (including a wrong token)
- a full round played to a winner
- `requestId` replay dedup — the same intent twice is answered once, not applied twice
- an absent player's turn passed via a simulated alarm
- the last-card declare and catch windows, including the head start
- pause, and the abandon vote
- play again
- **the room creator disconnecting mid-round and rejoining as an ordinary player**
- the privacy invariant, over a whole round

`worker/scripts/smoke.mjs` grows from "registration, claims, routing" to a
scripted multi-player round over real WebSockets against `wrangler dev`: two
clients join, a round is dealt, several moves land, one client disconnects and
resumes, and somebody wins.

Playwright moves onto the real worker: `wrangler dev` becomes a second
`webServer` in `playwright.config.ts`, and the build the suite previews is made
with `VITE_RELAY_URL=ws://127.0.0.1:8787` so both the app and its CSP point at it.
`.github/workflows/ci.yml` gains that build variable and the worker's dependencies
in the e2e job.

Coverage thresholds move with the code: the `hostSession.ts` and `hostSnapshot.ts`
entries in `vitest.config.ts` go, and the worker gains its own floor.

---

## 10. Order of work

Each step leaves `npm run verify` and `cd worker && npm run verify` green.

1. This document.
2. Share the engine into the worker: tsconfig `include`, `zod` dependency,
   `BotRunner.pump()`. Nothing uses it yet.
3. Protocol version 6: the removals, `roomCommand`, `creatorPlayerId`,
   `joinRequest{create}`. Client and worker both compile against it.
4. `worker/src/`: storage + validation, `AlarmMux`, `GameRoom`, and the DO adapter.
   Unit tests alongside.
5. `roomTransport.ts` and the `clientSession.ts` trim.
6. The store, the UI and the i18n deletions.
7. Smoke test, e2e rework, CI.
8. `architecture.md`, `threat-model.md`, `protocol.md`, `README.md`.

---

## 11. Cost, and what must not be renamed

Unchanged and non-negotiable:

- Worker name stays `supertaki-relay`, so the deployed URL stays
  `wss://supertaki-relay.ebenzvi.workers.dev`.
- The Durable Object class stays `RoomDO` and the binding stays `ROOM`, so the
  existing `migrations` tag needs no successor.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the `RELAY_URL` repository
  variable are untouched.
- SQLite-backed Durable Objects, hibernation, and alarms are all on the
  Cloudflare free plan. The change _reduces_ wake-ups: the host's 5 s heartbeat
  becomes a handful of exact alarms per round.
  **Only while no deadline is ever re-booked into the past.** `book()` floors the
  past at one second, so a handler that changes nothing plus a deadline that stops
  moving is 1 Hz for the life of the room — worse than the heartbeat it replaced.
  Written here because it is the sentence above that made it worth writing: the
  first implementation did exactly this on two deadlines, and the claim in this
  section was false for as long as it did. `worker/test/` now bounds the wake count.

Free-plan limits worth stating: 100,000 requests/day and 13 million ms/day of DO
compute. A six-player round is a few hundred messages. The 1 GB SQLite ceiling
holds two JSON blobs per live room and is emptied 6 h after the last player leaves.
