# Architecture

## The constraint that shapes everything

The application must cost exactly nothing and require no account from any player. The site
is static files on GitHub Pages; the network is one small WebSocket relay — a Cloudflare
Worker with one Durable Object per room — deployed from this repository to a free
Cloudflare account. The free plan needs no credit card, and a full game evening uses well
under one percent of its daily allowance.

This is the project's second network architecture. The first was WebRTC peer-to-peer with
the free public PeerJS broker for signalling, chosen to avoid running any server at all. It
failed in practice exactly where people play: networks whose NAT no amount of STUN can
traverse, iOS tearing the RTCPeerConnection down on every screen lock, a public broker that
held a dead peer id for a minute and blocked the host from reclaiming its own room. All of
it — STUN, TURN, ICE, the broker — is gone. A `wss://` connection on port 443 works
everywhere the web works, and reconnecting is reopening a socket.

So the architecture is: _static client + a dumb relay, with one player's browser as the
authority._

## Host-authoritative, relay-routed

```
                      ┌───────────────────────────────┐
                      │  Room relay (worker/)         │   one Durable Object
                      │  routes frames by peer id,    │   per room code,
                      │  reads none of them           │   hibernates when idle
                      └───────┬──────────┬────────────┘
                       wss:// │          │ wss://
        ┌─────────────────────┘          └─────────────┐
        │                          │                   │
┌───────▼────────┐        ┌────────▼───────┐  ┌────────▼───────┐
│  HOST browser  │        │ Client browser │  │ Client browser │
│                │        │                │  │                │
│ • full state   │        │ • public state │  │ • public state │
│ • all hands    │        │ • own hand only│  │ • own hand only│
│ • game engine  │        │ • same engine  │  │ • same engine  │
└────────────────┘        └────────────────┘  └────────────────┘
```

The topology is a **star**: every client holds exactly one logical connection, to the host,
multiplexed with everybody else's over the room's relay socket. Clients never talk to each
other, which removes any question of two peers disagreeing about state. The relay stamps
the sender's identity on every frame it routes, so no client can speak in another's name;
everything else about the game is opaque to it.

### Why the host, and what that means

- The room creator is the host. Its tab holds the only complete `GameState`, including every
  player's hand.
- Clients send **intents** (`{type: 'playCard', cardId}`), never state. The wire format has
  no way to express "here is the new game state", so a client cannot assert one.
- A client never states _who_ it is. The host binds a seat id to the connection at join
  time and injects that id into every command. Spoofing another player therefore requires
  taking over their data channel, not editing a field.
- The host runs each intent through the pure engine. The engine either returns a new state
  and events, or a rejection code. Rejections go back only to the player who asked.
- The host then broadcasts the new public state to everyone and sends each player their own
  hand privately.
- The host is also a player. Its own moves go through `submitLocalAction`, which calls the
  same `applyCommand` as a remote intent. There is no privileged path.

### State ownership and privacy

Three views of the same data:

| View              | Contains                                                                                | Who holds it     |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `GameState`       | every hand, the draw pile order, the RNG state                                          | host only        |
| `PublicGameState` | card _counts_, the visible discard top, active colour, direction, whose turn, Taki mode | everyone         |
| `PrivateHandView` | one player's cards                                                                      | that player only |

`toPublicGameState()` is the only function that produces the broadcast payload, and it
cannot leak a hand because it never reads card identities other than the discard top. A unit
test asserts that no card id from any hand or from the draw pile appears in the serialised
public snapshot, and a Playwright test asserts the same in real rendered HTML.

Clients receive `PublicGameState` plus their own hand, which is exactly enough to run
`isCardPlayable()` locally. That is why the UI can highlight legal cards instantly without a
round trip, while the host still has the final word.

### Determinism

The engine never calls `Math.random()` or `Date.now()`. All randomness flows through a
serialisable `RngState` (mulberry32) that is part of the game state, and shuffling is a pure
function of `(cards, rngState)`. Given the same seed, the same deal and the same reshuffles
happen every time — which is what makes the rule tests exact rather than statistical.

The host generates the seed and keeps it in state. It does not need to send the seed to
clients (they cannot deal, only render), but the state is fully serialisable, so it could.

### Version numbers

`GameState.version` increments on every accepted command and is carried on every public
snapshot and private hand. Clients drop any snapshot older than the newest one they have
already applied, so a late-arriving message can never roll the table back.

Versions are **monotonic across rounds**: a second deal continues the sequence rather than
restarting at 1. (This was a real bug found in end-to-end testing — clients silently
discarded the new deal as stale. `createGame` now takes a starting version and the host
tracks a `versionFloor`.)

## Layering

```
UI (React)                     src/features/game/ui, src/app, src/components
   │ reads derived view-models, dispatches store actions
Application state (Zustand)    src/features/game/state
   │ owns the live session, maps SessionUpdate -> renderable state
Session layer                  src/features/game/network/{host,client}Session.ts
   │ speaks the protocol, owns heartbeats, reconnection, seats
Transport abstraction          src/features/game/network/transport.ts
   │ relay | broadcast | memory
Pure game engine               src/features/game/engine
```

Enforced by import direction, not just convention:

- `engine/` imports nothing from `network/`, `state/`, `ui/` or the DOM. It is plain
  TypeScript, fully unit-testable, and never mutates its input.
- `network/` imports the engine (the host needs to run it) but never the UI.
- `state/` is the only place that knows both a session and the UI exist.
- `ui/` contains no rules. When it needs to know whether a card is legal it calls the
  engine's `isCardPlayable` — the same function the host uses.

### The transport seam

`Transport` is a four-method interface (`ready`, `connect`, `onIncoming`, `onError`) plus a
connection object (`send`, `onData`, `onClose`, `onError`, `close`). Three implementations:

| Kind        | Used for                           | Notes                                                                                |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `relay`     | production                         | Virtual channels multiplexed over one WebSocket to the room's Durable Object         |
| `broadcast` | end-to-end tests, same-device play | `BroadcastChannel` between tabs of one browser; selected with `?transport=broadcast` |
| `memory`    | unit tests                         | In-process, microtask delivery, no timers                                            |

This seam is what makes the multiplayer logic testable at all. The Playwright suite plays a
complete round through two real pages, the real protocol, the real host authority and the
real engine — only the bytes travel over `BroadcastChannel` instead of the relay. The relay
itself is covered from the other side: `worker/` has protocol unit tests, and its smoke
test (`npm run smoke`) drives real WebSocket clients through the live server under
`wrangler dev`, including claim arbitration and host reclaim.

## Data flow of one move

```
1. Player taps a card
2. UI: is it a wild card? -> open the colour modal, wait for a choice
3. store.playCard(cardId, chosenColor?)  ->  session.submitAction({type:'playCard', ...})
4. Client session wraps it in an envelope (protocol version, message id, room id,
   sender peer id, timestamp) and sends it on the data channel
5. Host: parseClientMessage() validates the envelope and payload with Zod
   - wrong protocol version -> joinRejected(protocolMismatch)
   - wrong room id          -> ignored
   - duplicate message id   -> ignored
   - malformed              -> ignored
6. Host resolves the seat bound to that connection, builds a GameCommand with that
   player id, and calls applyCommand(state, command)
7a. Rejected -> actionRejected(code) to that player only -> localised toast
7b. Accepted -> new state, version + 1
      - broadcast publicState to everyone
      - send each player their own privateHand
      - broadcast gameEvents (the log lines)
8. Every client validates, drops stale versions, and re-renders
```

The host's own move enters at step 6 directly, through the same function.

## Connection lifecycle

`idle → initializing → ready → connecting → connected`, with `reconnecting`,
`disconnected` and `failed` as the unhappy paths. The current phase is always visible in the
UI; it is never hidden behind a spinner that could last forever.

- **Timeouts.** 15 s to open a data connection, 12 s to complete the join handshake.
- **Retries.** Bounded exponential backoff: 1 s, 2 s, 4 s, 8 s, 12 s, then stop and offer a
  manual retry.
- **Fail fast where retrying is pointless.** "No such peer" _before_ joining means the room
  code is wrong or the host is gone; retrying for 15 seconds only delays an answer the
  player needs immediately, so it fails at once. (Another finding from end-to-end testing.)
- **Definitive rejections stop the loop.** Room full, bad rejoin token, join timeout — the
  automatic retry is disabled and the UI offers an explicit "Try again" instead.
- **Heartbeat.** The host pings every 5 s; a client answers with a matching pong. Silence
  for more than 9 s marks a player _unstable_, more than 20 s marks them _disconnected_.
  Both states are shown per player in the lobby and during the game.
- **Client-side watchdog.** A client that hears nothing from the host for 20 s closes the
  channel and starts reconnecting, rather than sitting on a dead connection.
- **Browser events.** `offline` moves the phase to `disconnected`; `online` triggers a
  reconnect attempt.
- **Duplicate connections.** A second channel from the same peer id closes the first with
  `kicked(duplicateConnection)`, so a re-opened tab takes over cleanly instead of two
  channels fighting.

## Reconnection model

When a player joins, the host issues a random 16-byte `resumeToken` bound to their seat. The
client stores `{roomCode, hostPeerId, playerId, resumeToken, displayName, savedAt}` in
`localStorage` with a 6-hour expiry.

On refresh:

1. The client sends `resumeRequest {playerId, resumeToken}` instead of `joinRequest`.
2. The host looks up the seat, compares the token, and closes any other channel still bound
   to that seat.
3. The host replies `joinAccepted`, then re-sends the lobby, the public state and that
   player's private hand.

If the seat is gone or the token does not match, the host replies `joinRejected` with
`unknownSeat` or `invalidResumeToken`. The client drops the dead credential and the UI offers
a fresh join or a new room — it does not silently retry a credential that can never work.

Mid-game, a seat is **kept** when its connection drops (so the player can come back) but
**freed** if the drop happens in the lobby. A round that ends drops any seat that never
returned before dealing again.

The token is a local reconnection secret, not an authentication credential against a shared
server: the only thing it protects is one seat in one private room, and the only party
checking it is the host's own tab.

## Known limitations

1. **The relay is a single point of failure.** If Cloudflare's edge (or the worker's free
   plan) has a bad day, no game traffic flows. The app reports the outage honestly and
   retries with jittered, capped backoff. This trade was made knowingly: the peer-to-peer
   design it replaced had a single point of failure too (the public signalling broker), plus
   an entire family of NAT and mobile-lifecycle failures of its own on top.
2. **Latency is two hops.** A move travels player → relay → host → relay → players, rather
   than directly between browsers. For a turn-based card game measured in human seconds,
   tens of milliseconds of relay hop are unnoticeable.
3. **No _automatic_ host migration.** A host can hand the room over explicitly, and a host
   that reloads, crashes or loses its device can take the room back on the same code (see
   "Surviving a disconnect"). What is deliberately absent is a silent host being replaced
   without its consent: "the host is gone" is still a single unverifiable observation from
   any one client's seat, and two live hosts serving divergent games is a worse failure than
   a table agreeing to stop.
4. **No spectators.** New players cannot join after the game starts. The protocol has a
   `wantsSpectator` flag reserved, but the behaviour is not implemented and the host rejects
   late joins with `gameInProgress`.
5. **The host has more power than a server would.** A modified host client could deal itself
   a good hand. This is a private game among people who know each other; see
   [threat-model.md](threat-model.md).
6. **Nothing is persisted beyond the players' own devices.** There is no history, no ranking
   and no stored replay. The host's room _is_ written down — to `localStorage`, with a
   six-hour TTL, because the game surviving a host crash is a requirement; the entry
   contains every hand, so it is validated on read, expired aggressively and erased on an
   intentional leave. See [threat-model.md](threat-model.md).
7. **Mobile background tabs still drop connections.** Nothing in a web page can prevent it.
   What has changed is the response: the page notices it woke, probes the socket at once,
   and reopening a WebSocket is cheap and reliable in a way ICE restarts never were. A
   screen wake lock keeps the game from sleeping while it is in front of the player.

## Surviving a disconnect

The design principle: **a disconnect is a pause, not the end.** Four mechanisms carry it.

**Liveness is judged by the wall clock, not by timers.** Every heartbeat tick reports how late
it was. A tick later than three intervals means the local page stopped running, so nobody is
convicted of anything — but nor is the peer presumed well, because a suspended tab has very
likely already lost its ICE consent (RFC 7675 gives it 30 s) while `open` stayed true. The
response is an immediate probe on a short deadline, and a rebuild if it goes unanswered.
Probes are correlated by nonce, so the evidence is _N unanswered questions_ rather than _N
quiet milliseconds_ — the latter was satisfied by any unrelated broadcast.

**Seat deadlines have one authority.** The host decides how long a seat is held and broadcasts
it; the client derives its own give-up deadline by subtraction. Two independent constants
would eventually disagree, and the countdown a player is shown would be contradicted by the
timer running underneath it.

**The host can always come back.** Its room is written to `localStorage` after every change —
the structural fields at once, the deck throttled, everything flushed on `pagehide`, which
also sends a `restarting` notice so the silence is never ambiguous. The room's relay claim is
written with it. On return — after a reload, a closed tab, or a crashed browser — the relay
recognises the claim and hands back the _same_ room code immediately; the snapshot restores
the host's player id, the version floor and the game. Every guest's credential still fits, and
the guests never lost their relay connection at all: they were sitting in the room watching
for the host's `peerUp`, so they reconnect unprompted the moment it appears.

**The table keeps moving.** An absent player's turn is passed after a short grace — free,
except that an outstanding +2 run is still paid, since that is an obligation somebody else
created. A breaker window waiting on an absent seat is resolved immediately, because it freezes
every seat and is invisible to any check based on whose turn it is. A seat that leaves for good
is _marked_, never deleted. Any player can pause the table, and the table can agree to end a
round with no winner.

Rejected, for the record: a heartbeat inside a Web Worker (Chrome freezes a page's workers
along with the page, and iOS suspends both), and server-side game state (the relay stores
nothing but peer-id claims — keeping the host authoritative keeps hands off any server).

## Why this much backend and no more

The relay is the smallest backend that removes the failures that actually ended games:
about two hundred lines that route frames and remember which claim owns which peer id. It
holds no game state, so a relay compromise or outage can corrupt nothing — the host's
browser remains the only authority. Anything bigger — accounts, a database, server-side
rules — would add operational surface and a billing relationship without fixing a failure
this game actually has. The free plan requires no payment details; if its terms ever
change, the worker is ordinary TypeScript behind a four-frame protocol and can move
anywhere that runs WebSockets.
