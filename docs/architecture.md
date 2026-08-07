# Architecture

## The constraint that shapes everything

The application must cost exactly nothing and require no account from any player. The site
is static files on GitHub Pages; the game runs in one small Cloudflare Worker with one
Durable Object per room, deployed from this repository to a free Cloudflare account. The
free plan needs no credit card, and a full game evening uses well under one percent of its
daily allowance.

This is the project's third network architecture, and the two before it are worth stating
because the current one is the answer to both.

The first was WebRTC peer-to-peer with the free public PeerJS broker for signalling, chosen
to avoid running any server at all. It failed exactly where people play: networks whose NAT
no amount of STUN can traverse, iOS tearing the `RTCPeerConnection` down on every screen
lock, a public broker that held a dead peer id for a minute and blocked the host from
reclaiming its own room.

The second replaced all of that with one `wss://` socket to a relay that routed frames
between named peers. It fixed the connectivity and left the second problem untouched: the
game still lived in one player's browser tab. Everything difficult in the codebase was
built to survive that tab going away — the whole game state mirrored into `localStorage`, a
room-code reclaim with a retry ladder, a "carry on hosting" card, a voluntary handover
protocol with generations — and the honest summary was a line in the UI telling players the
game could not continue without the host.

The third moves the game into the room. The Durable Object every player was already
connected to holds the state, and the apparatus above is deleted rather than improved.

So the architecture is: **a static client, and the room is the server.**

## Server-authoritative rooms

```
                      ┌───────────────────────────────┐
                      │  Room (worker/)               │   one Durable Object
                      │  • full GameState, all hands  │   per room code,
                      │  • the rules engine           │   SQLite-backed,
                      │  • every deadline, on alarms  │   hibernates when idle
                      └───┬───────────┬───────────┬───┘
                   wss:// │           │ wss://    │ wss://
        ┌─────────────────┘           │           └─────────────┐
┌───────▼────────┐          ┌─────────▼──────┐        ┌─────────▼──────┐
│ Player browser │          │ Player browser │        │ Player browser │
│ • public state │          │ • public state │        │ • public state │
│ • own hand only│          │ • own hand only│        │ • own hand only│
│ • same engine, │          │ • same engine, │        │ • same engine, │
│   for the UI   │          │   for the UI   │        │   for the UI   │
└────────────────┘          └────────────────┘        └────────────────┘
```

Every player is the same kind of thing, including whoever opened the room. Clients never
talk to each other, and there is no player whose disappearance means more than any other's.

### Why the room, and what that means

- The room holds the only complete `GameState`, including every player's hand.
- Clients send **intents** (`{type: 'playCard', cardId}`), never state. The wire format has
  no way to express "here is the new game state", so a client cannot assert one.
- A client never states _who_ it is. The room binds a seat to the socket when the join is
  accepted and injects that id into every command. Speaking in another player's name would
  require their socket, not an edited field.
- The room runs each intent through the same pure engine the browser uses for highlighting.
  The engine returns a new state and events, or a rejection code. Rejections go back only to
  the player who asked.
- The room then broadcasts the new public state to everyone and sends each player their own
  hand privately, on their own socket.
- **The room creator has no privileged path.** They hold the lobby buttons — start, kick,
  seat size, seat a robot — authorised against `creatorPlayerId`, and nothing else. Their
  moves take exactly the route everybody's take.

### State ownership and privacy

Three views of the same data:

| View              | Contains                                                                                | Who holds it     |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `GameState`       | every hand, the draw pile order, the RNG state                                          | the room only    |
| `PublicGameState` | card _counts_, the visible discard top, active colour, direction, whose turn, Taki mode | everyone         |
| `PrivateHandView` | one player's cards                                                                      | that player only |

`toPublicGameState()` is the only function that produces the broadcast payload, and it
cannot leak a hand because it never reads card identities other than the discard top. A
worker test plays a whole round and asserts that no card id from anybody's hand ever appears
in any frame sent to another player — the property itself, asserted where the frames are.

This is stricter than the arrangement it replaced. Every hand used to be in the host's tab,
which belonged to a player; a modified client that happened to be the host could see
everything. Now no player's device holds anything but their own cards. What changed in the
other direction is that the hands exist on Cloudflare's edge for the life of the room —
stated plainly in `threat-model.md`.

Clients receive `PublicGameState` plus their own hand, which is exactly enough to run
`isCardPlayable()` locally. That is why the UI can highlight legal cards instantly without a
round trip, while the room still has the final word.

### Determinism

The engine never calls `Math.random()` or `Date.now()`. All randomness flows through a
serialisable `RngState` (mulberry32) that is part of the game state, and shuffling is a pure
function of `(cards, rngState)`. Given the same seed, the same deal and the same reshuffles
happen every time — which is what makes the rule tests exact rather than statistical.

The room generates the seed and keeps it in state, which is written to SQLite with
everything else. A round therefore replays identically across a hibernation, an eviction, or
a redeployment of the worker.

### Version numbers

`GameState.version` increments on every accepted command and is carried on every public
snapshot and private hand. Clients drop any snapshot older than the newest one they have
already applied, so a late-arriving message can never roll the table back.

Versions are **monotonic across rounds**: a second deal continues the sequence rather than
restarting at 1. (This was a real bug found in end-to-end testing — clients silently
discarded the new deal as stale. `createGame` takes a starting version and the room tracks a
`versionFloor`, which is persisted.)

### Durable state, and what survives what

Nothing the room needs lives only in memory. The Durable Object is evicted between messages
by design — that is what makes an idle room free — so its in-memory `GameRoom` is a cache,
rebuilt on any wake from two places:

| What                                     | Where it comes back from                            |
| ---------------------------------------- | --------------------------------------------------- |
| live sockets, and the seat each one owns | `ctx.getWebSockets()` plus each socket's attachment |
| seats, credentials, votes, clocks        | the `room` record in the object's SQLite            |
| the deck, every hand, the RNG state      | the `game` record in the same                       |

Both records are single JSON blobs, validated with Zod on the way out as well as in. A row
that does not parse is treated as _no room_ rather than half-believed: a partly-read table
can sit in a state the engine has no transition out of, and every seat's move is then
refused with nothing to explain it.

### Timers are alarms, and there is only one

A Durable Object gets a single alarm, so `worker/src/alarms.ts` multiplexes every deadline
the room keeps onto it — the absent-turn skip, seat grace, a robot's thinking pause, the
robot stall backstop, the stand-in threshold, the last-card window, the idle nudge, and the
room's own idle TTL. `set` and `clear` write a row and re-arm the platform alarm to the
earliest remaining deadline; the handler collects everything due, in a fixed rank order.

This replaced a 5–15 second heartbeat that swept for all of it on every tick. That shape was
wrong twice: it would wake the object hundreds of times a round, defeating the hibernation
the zero-cost story depends on, and it was only a polling approximation of deadlines the
room already knows the exact time of.

One rule is worth stating on its own: **an empty room does nothing.** With nobody connected,
every round deadline is cleared and only the TTL remains. Without that, two players closing
their tabs would leave a round where the seat on turn is always absent — so the room passes
it, which makes the next absent seat the one on turn, and it passes that too, for six hours.

### Presence is observed, not inferred

A seat is present exactly when the room is holding an open socket for it. The runtime
delivers a close event when one goes, so there is nothing to deduce.

The previous design could not do this: the authority was another browser, which could only
infer presence from unanswered probes. That inference was `ProbeTracker`, a probe cadence, a
count of misses before "unstable", another before "silent", a floor derived from ICE consent
freshness, a watchdog that could tell "the peer died" from "we were asleep", and a third
health state meaning "we are not sure yet". All of it is deleted. Seat health has two values.

The `ping`/`pong` that remains is for the _client's_ benefit and never reaches the room: a
phone coming out of sleep genuinely cannot tell a live socket from a half-open one, so it
asks. Those frames are answered by the Cloudflare runtime's auto-responder while the object
stays hibernated — which is why they are a bare string rather than a game message.

## Layering

```
UI (React)                     src/features/game/ui, src/app, src/components
   │ reads derived view-models, dispatches store actions
Application state (Zustand)    src/features/game/state
   │ owns the live session, maps SessionUpdate -> renderable state
Session layer                  src/features/game/network/clientSession.ts
   │ speaks the protocol, owns joining, reconnection, the outbox
Room socket                    src/features/game/network/roomTransport.ts
   │ one WebSocket, a liveness probe, and nothing else
Pure game engine               src/features/game/engine
```

The same engine runs in the worker, borrowed by relative import rather than copied — see
`docs/server-game-plan.md` §3. Both `tsconfig`s compile it, so a rules change that breaks
the room fails the app's typecheck _and_ the worker's.

Enforced by import direction, not just convention:

- `engine/` imports nothing from `network/`, `state/`, `ui/` or the DOM. It is plain
  TypeScript, fully unit-testable, and never mutates its input.
- `network/` imports the engine (the client needs it to highlight legal cards) but never the
  UI.
- `state/` is the only place that knows both a session and the UI exist.
- `ui/` contains no rules. When it needs to know whether a card is legal it calls the
  engine's `isCardPlayable` — the same function the room uses to decide.

### The socket seam

`ClientSession` takes a `ChannelFactory` — `(roomCode) => Promise<RoomChannel>` — so what it
talks to is an argument rather than a global. In production that is a `WebSocket`; in the
app's own tests it is an in-memory pipe with the **real** `GameRoom` on the other end, so a
disagreement between the two halves of the protocol fails a unit test rather than a game.

There used to be three transports here (`relay`, `broadcast`, `memory`) and a factory to
choose between them. The `broadcast` one existed so two tabs could play without a signalling
server, which was worth having when the alternative was a public broker. It is gone: the e2e
suite now runs against the real worker under `wrangler dev`, so there is no longer a reason
to maintain a second transport with different semantics that no user path takes.

Coverage of the room comes from four directions:

| Where                      | What it drives                                                 |
| -------------------------- | -------------------------------------------------------------- |
| `worker/test/`             | `GameRoom` in plain Node — injected sockets, storage, clock    |
| `tests/unit/` (app)        | the store and the client session, against a real `GameRoom`    |
| `worker/scripts/smoke.mjs` | real workerd, real Durable Object, real SQLite, real sockets   |
| `tests/e2e/`               | two browser pages against `wrangler dev` — the production path |

## Data flow of one move

```
1. Player taps a card
2. UI: is it a wild card? -> open the colour modal, wait for a choice
3. store.playCard(cardId, chosenColor?)  ->  session.submitAction({type:'playCard', ...})
4. Client session wraps it in an envelope (protocol version, message id, room id,
   connection label, timestamp) with a requestId, and sends it on its socket
5. Room: a frame over 128 KiB closes the socket unparsed; otherwise
   parseClientMessage() validates the envelope and payload with Zod
   - wrong protocol version -> joinRejected(protocolMismatch), so the tab reloads
   - wrong room id          -> ignored
   - duplicate message id   -> ignored
   - malformed JSON         -> the socket is closed, and the seat marked away
6. Room resolves the seat bound to that socket, and:
   - a repeated requestId is answered from the seat, not applied again
   - a turn-scoped intent whose turnToken is stale is rejected as notYourTurn
   - otherwise it builds a GameCommand with that player id and calls
     applyCommand(state, command)
7a. Rejected -> actionRejected(code, requestId) to that player only -> localised toast
7b. Accepted -> new state, version + 1, written to the object's SQLite
      - actionAccepted(requestId, version) to the player who asked
      - broadcast publicState to everyone
      - send each player their own privateHand
      - broadcast gameEvents (the log lines)
      - re-arm the one alarm for whichever deadline is now earliest
8. Every client validates, drops stale versions, and re-renders
```

A robot's move enters at step 6's last line directly, through the same function. There is no
other entrance: nothing in the room can move the game except `applyCommand`.

## Connection lifecycle

`idle → connecting → connected`, with `reconnecting`, `disconnected` and `failed` as the
unhappy paths. The current phase is always visible in the UI; it is never hidden behind a
spinner that could last forever.

- **Timeouts.** 8 s to open the first socket, 20 s for later attempts (nobody is watching
  those), and 15 s for the join handshake.
- **Retries.** Bounded backoff with 30 % jitter: 0 s, 1 s, 2 s, 5 s, 10 s, 20 s, 30 s. The
  first attempt is immediate, because whatever triggered it — a wake, an `online` event, a
  socket close — is new information.
- **Definitive rejections stop the loop.** Room full, game in progress, bad rejoin token —
  the automatic retry is disabled and the UI offers an explicit "Try again" instead.
- **Liveness probes.** The client sends a bare `ping` every 15 s and expects a `pong` within
  3 s. The Cloudflare runtime answers it via `setWebSocketAutoResponse`, so a probe never
  wakes the object and never costs a request; the cadence is 15 s rather than 5 s because a
  faster one keeps a cellular modem out of its idle state for no gain. Two consecutive
  unanswered probes close the socket and start reconnecting.
- **Presence is observed, not inferred.** A client no longer guesses whether _another_ player
  is there. The runtime tells the room when a socket closes, and the room publishes that. The
  whole apparatus of probe accounting — miss counts, an "unstable" state, a consent-freshness
  floor — went with the guessing.
- **Browser events.** `offline` moves the phase to `disconnected`; `online`, a `visibilitychange`
  back to visible, and a `pageshow` each trigger an immediate probe or reconnect.
- **Duplicate connections.** A second socket accepted for a seat closes the first with a
  `superseded` close code, so a re-opened tab takes over cleanly instead of two sockets
  fighting.

## Reconnection model

When a player joins, the room issues a random 16-byte `resumeToken` bound to their seat. The
client stores `{roomCode, playerId, resumeToken, displayName, savedAt}` in `localStorage`
with a 6-hour expiry, matching the room's own idle TTL — so the credential and the room it
opens expire together.

On refresh:

1. The client sends `resumeRequest {playerId, resumeToken}` instead of `joinRequest`.
2. The room looks up the seat, compares the token, and closes any other socket still bound
   to that seat.
3. The room replies `joinAccepted`, then re-sends the lobby, the public state and that
   player's private hand.

If the seat is gone or the token does not match, the room replies `joinRejected` with
`unknownSeat` or `invalidResumeToken`. The client drops the dead credential and the UI offers
a fresh join or a new room — it does not silently retry a credential that can never work.

**Every seat is resumable, including the room creator's.** That is the whole difference from
the design this replaced, where the creator's seat was the authority and an authority cannot
rejoin itself. Their reload is one tap on the same card everybody else gets.

Mid-game, a seat is **kept** when its socket drops (so the player can come back) but **freed**
if the drop happens in the lobby. A round that ends drops any seat that never returned before
dealing again.

The token is a reconnection secret for a private game with no stakes, not an authentication
credential: the only thing it protects is one seat in one room.

## Robot players

A robot is a **room-side policy**, not a peer and not part of the engine. It exists in three
files under `src/features/game/bot/`, and it is wired to the room in one place: a driver that
watches for a seat a robot is playing, waits a human-shaped moment, and submits an ordinary
`GameAction` through `applyAction` — the same function a remote intent arrives at.

Two properties are load-bearing, and both are structural rather than promised:

- **A robot knows only what a client knows.** `botViewFor()` builds its input out of
  `toPublicGameState()` plus that seat's own hand — the same two projections the room
  broadcasts. It cannot read the draw pile, another hand, or the private list of who holds a
  +3 Breaker; it infers whether it may answer a +3 from its own cards, exactly as the UI does.
- **A robot can express nothing a player cannot.** Its decisions are typed as the wire's
  `GameAction`, so the room-only commands (`skipTurn`, `leaveGame`, `abandonRound`) are
  unreachable from it. A refused robot move buys no privilege either: at most it pays a card
  from the pile, as any player in that position would.

A robot's thinking pause is a Durable Object alarm rather than a timer, because the object is
routinely evicted between moves — which is why `BotRunner.pump()` re-decides from the current
table rather than replaying a decision it cannot have kept.

The one place the room acts _for_ a robot is a deadline. A robot cannot be absent, so none of
the seat machinery would ever rescue a table stuck on one; past `BOT_STALL_MS` the room passes
the seat itself and logs that it had to.

Robots may also cover a **human** seat — after 45 s of absence, or 90 s of silence from a seat
that is present — when the table has that turned on. The seat stays entirely its owner's, and
comes back to them on their next intent, which is measured from what they _ask for_ and never
from traffic: a phone in a pocket keeps a socket open perfectly. The full behaviour, the
thresholds and the fairness argument are in [robots.md](robots.md).

## Known limitations

1. **The room is a single point of failure.** If Cloudflare's edge (or the worker's free plan)
   has a bad day, no game runs. The app reports the outage honestly and retries with jittered,
   capped backoff. This trade was made knowingly, twice: the peer-to-peer design had a single
   point of failure too (the public signalling broker) _plus_ an entire family of NAT and
   mobile-lifecycle failures, and the host-authoritative design had one per room in the form
   of a player's phone.
2. **Latency is one hop.** A move travels player → room → players. For a turn-based card game
   measured in human seconds this is unnoticeable, and it is one hop fewer than the relay
   design, where everything went through the host as well.
3. **No spectators.** New players cannot join after the game starts; the room rejects late
   joins with `gameInProgress`.
4. **The operator can read hands.** They are in a Durable Object, so whoever holds the
   Cloudflare account could inspect them. No player can, which is the direction that matters
   and is stricter than before — the host used to be a player. See
   [threat-model.md](threat-model.md).
5. **Nothing is persisted beyond the room's lifetime.** No history, no ranking, no stored
   replay. The room's own storage is deleted six hours after the last player leaves. The only
   thing on a device is a seat credential, with the same expiry.
6. **Mobile background tabs still drop connections.** Nothing in a web page can prevent it.
   What has changed is the response: the page notices it woke, probes the socket at once, and
   reopening a WebSocket is cheap and reliable in a way ICE restarts never were. A screen wake
   lock keeps the game from sleeping while it is in front of the player.

## Surviving a disconnect

The design principle: **a disconnect is a pause, not the end.** Three mechanisms carry it,
and one that used to be here is gone because it has nothing left to do.

**Nobody's departure is special.** There is no seat whose loss ends the game, so the question
"has the host gone?" — which was a single unverifiable observation from any one client's seat,
and the reason an automatic takeover could never be made safe — is not asked. Any player, or
all of them, can vanish and come back to the table they left.

**Seat deadlines have one authority.** The room decides how long a seat is held and broadcasts
it; the client derives its own give-up deadline by subtraction. Two independent constants would
eventually disagree, and the countdown a player is shown would be contradicted by the timer
running underneath it.

**A client that woke up asks rather than assumes.** A suspended tab very likely lost its TCP
connection while `readyState` stayed `OPEN`, so believing the socket is how a player ends up
watching a table that will never update. The response to a wake is a probe on a short deadline,
and a rebuild if it goes unanswered.

**The table keeps moving.** An absent player's turn is passed after a short grace, at the
price of the turn: one card from the pile, exactly what a present player pays for a turn they
play nothing on — or the whole +2 run when they owed one, since that is an obligation somebody
else created. A pass that cost nothing made a dropped connection the cheapest turn at the
table, because a hand that cannot grow cannot lose. A breaker window waiting on an absent seat is resolved immediately, because it freezes
every seat and is invisible to any check based on whose turn it is. A seat that leaves for good
is _marked_, never deleted. Any player can pause the table, and the table can agree to end a
round with no winner. All of it runs on alarms — and stops entirely when nobody is connected,
because there is then nobody it could be moving the table for.

Rejected, for the record: a heartbeat inside a Web Worker (Chrome freezes a page's workers
along with the page, and iOS suspends both), and inferring presence from probe accounting,
which is what the room replaced with an observation.

## Why this much backend and no more

The room is the smallest backend that removes the failures that actually ended games. It is
a rules engine the client already contains, a JSON blob in SQLite, and a queue of deadlines
on one alarm — and it deleted about three and a half thousand lines of client code that
existed only to survive the previous arrangement.

What is deliberately _not_ here: accounts, a database of players, a lobby service, a match
history, a ranking, a chat server. None of them fixes a failure this game has, and each
would add operational surface and, eventually, a billing relationship.

The free plan requires no payment details. If its terms ever change, the room is ordinary
TypeScript — `GameRoom` takes its sockets, its storage, its alarms and its clock as
arguments, which is why it can be unit-tested in plain Node, and is also why it could be
re-hosted anywhere that offers a socket, a key-value store and a timer.

### What it costs to run

| Resource               | Free plan / day | A six-player evening                         |
| ---------------------- | --------------- | -------------------------------------------- |
| Worker requests        | 100,000         | one per socket opened and one per alarm wake |
| Durable Object compute | 13,000,000 ms   | a few seconds of actual work                 |
| Durable Object storage | 1 GB            | two JSON blobs per live room, deleted at TTL |

The shape that keeps this true is hibernation: between messages the object is evicted and
costs nothing, liveness probes are answered by the runtime without waking it, and the room's
own deadlines are exact alarms rather than a poll. A room with nobody in it does nothing at
all until its six-hour TTL fires and deletes it.

One rule holds the whole column up, and it is easy to break by accident: **a deadline that has
already passed must never be re-booked.** `book()` floors a past deadline at one second out, so
a handler that changes nothing plus a deadline recomputed from an unmoving clock is a room that
wakes every second until the TTL kills it — 86,400 requests a day from a single table, which is
most of the allowance above. That is not hypothetical: the `idleNudge` and mid-round `seatGrace`
deadlines both did it, on the commonest paths in the game, and an audit found them rather than a
bill. Three tests now bound the number of wakes — exactly one for a table waiting on a present
player, exactly none for a paused one, and a ceiling for a dropped seat — because "it looks like
it settles" is not something a reader of `reschedule` can check by eye.
