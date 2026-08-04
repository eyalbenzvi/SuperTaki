# Architecture

## The constraint that shapes everything

The application must be a static site on GitHub Pages and must cost exactly nothing. That
rules out, in order:

- a game server (nothing to run it on),
- a database (nothing to host it),
- serverless functions (a paid or billing-gated product everywhere),
- a signalling server of our own (needs a long-lived WebSocket process),
- a TURN relay (bandwidth costs money).

What remains is: **static files, plus whatever the browsers can do between themselves.**
Browsers can open direct encrypted data channels to each other (WebRTC), provided a third
party helps them exchange connection descriptions once (signalling). PeerJS provides a free
public broker for exactly that step, and public STUN servers help each browser discover its
own address. Both are free and require no account.

So the architecture is: _static client + peer-to-peer mesh, with one peer elected as the
authority._

## Host-authoritative peer-to-peer

```
                      ┌──────────────────────────┐
                      │  Public PeerJS broker    │   used once per connection,
                      │  (free signalling)       │   for the handshake only
                      └────────────┬─────────────┘
                                   │ (SDP/ICE exchange)
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐        ┌────────▼───────┐         ┌────────▼───────┐
│  HOST browser  │◄──────►│ Client browser │         │ Client browser │
│                │  data  │                │         │                │
│ • full state   │ channel│ • public state │         │ • public state │
│ • all hands    │◄───────┼─ own hand only │         │ • own hand only│
│ • game engine  │  (star)│ • same engine  │         │ • same engine  │
└────────────────┘        └────────────────┘         └────────────────┘
        ▲                                                     │
        └─────────────────── data channel ────────────────────┘
```

The topology is a **star**, not a mesh: every client holds exactly one data connection, to
the host. Clients never talk to each other. With at most six players that means at most
five connections for the host — comfortable — and it removes any question of two peers
disagreeing about state.

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
   │ peerjs | broadcast | memory
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
| `peerjs`    | production                         | Real WebRTC data channels, JSON serialisation, public broker                         |
| `broadcast` | end-to-end tests, same-device play | `BroadcastChannel` between tabs of one browser; selected with `?transport=broadcast` |
| `memory`    | unit tests                         | In-process, microtask delivery, no timers                                            |

This seam is what makes the multiplayer logic testable at all. The Playwright suite plays a
complete round through two real pages, the real protocol, the real host authority and the
real engine — only the bytes travel over `BroadcastChannel` instead of ICE. Public
signalling and NAT traversal cannot be made deterministic in CI, and pretending otherwise
would produce a flaky suite that hides real regressions.

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

1. **Relay is best-effort, not guaranteed.** PeerJS ships two community TURN relays in its
   default configuration, and `peerTransport.ts` now _merges_ that default rather than
   replacing it — which it used to, silently discarding the only relay candidates the project
   has. With them, symmetric NAT, carrier NAT and IPv6-only mobile networks generally work.
   What is still not covered: the relays are UDP/3478 only, with no `turns:`/443 entry, so a
   network that blocks outbound UDP entirely cannot connect at all; and they are donated,
   best-effort, and could go away. `probeConnectivity()` diagnoses which case a player is in
   _before_ they send invites, rather than leaving them with a spinner.
2. **Signalling depends on a free public service.** The PeerJS broker is best-effort. If it
   is down, new rooms cannot be created; existing data channels keep working, because
   signalling is only needed for the handshake. A host that cannot re-register says so, and
   the reconnection loop is capped and jittered so a room full of clients stays a good
   citizen of a shared service.
3. **No _automatic_ host migration.** A host can hand the room over explicitly, and a host
   that reloads or crashes can take it back on the same room code (see "Surviving a
   disconnect"). What is deliberately absent is a silent host being replaced without its
   consent. It cannot be made safe here: PeerJS's signalling socket and its data channels
   have independent lifetimes, so a host that has only lost the broker keeps serving everyone
   already connected while being unable to accept anybody new — and a client that cannot
   reach it has no way to tell that from death, because clients have no mesh between them and
   "the host is gone" is a single unverifiable observation. Two live hosts serving divergent
   games is reachable, and a digest of the state proves authenticity rather than recency, so
   a successor could take over several moves in the past and be believed. A table that needs
   to stop can agree to stop instead.
4. **No spectators.** New players cannot join after the game starts. The protocol has a
   `wantsSpectator` flag reserved, but the behaviour is not implemented and the host rejects
   late joins with `gameInProgress`.
5. **The host has more power than a server would.** A modified host client could deal itself
   a good hand. This is a private game among people who know each other; see
   [threat-model.md](threat-model.md).
6. **Nothing is persisted beyond the tab.** There is no history, no ranking and no stored
   replay. The host's room _is_ written down, but to `sessionStorage`: it survives a reload
   and dies with the tab, because it contains every hand and the deck order.
7. **A hard-killed host tab cannot be recovered.** A reload is; an operating system closing
   the tab is not, because that clears `sessionStorage`. Writing everybody's cards to
   persistent storage on a possibly-shared device is the price of covering it, and it is not
   worth paying.
8. **Mobile background tabs still drop connections.** Nothing in a web page can prevent it.
   What has changed is the response: the page notices it woke, probes at once instead of
   waiting for a throttled timer, and never mistakes its own sleep for the other side
   leaving. A screen wake lock keeps the game from sleeping while it is in front of the
   player.

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

**The host can come back.** Its room is written to `sessionStorage` after every change — the
structural fields at once, the deck throttled, everything flushed on `pagehide`, which also
sends a `restarting` notice so the silence is never ambiguous. On return it reclaims the _same_
room code for seventy-five seconds (the broker holds a dropped id for up to a minute, so the
id being refused is usually its own ghost), and restores its own player id and the version
floor along with the game. Every guest's credential still fits, so they reconnect unprompted.

**The table keeps moving.** An absent player's turn is passed after a short grace — free,
except that an outstanding +2 run is still paid, since that is an obligation somebody else
created. A breaker window waiting on an absent seat is resolved immediately, because it freezes
every seat and is invisible to any check based on whose turn it is. A seat that leaves for good
is _marked_, never deleted. Any player can pause the table, and the table can agree to end a
round with no winner.

Rejected, for the record: a heartbeat inside a Web Worker (Chrome freezes a page's workers
along with the page, and iOS suspends both), and a `localStorage` mirror of the host snapshot
(it would put every hand on disk to cover the rare crash-with-tab-close).

## Why no backend

Any backend — a small VPS, a managed database, a single serverless function — would make
several of the limitations above disappear. Every one of those options either costs money,
requires billing details on file, or depends on a free tier that can be withdrawn. The
project's requirement is _exactly zero_ third-party cost with no billing relationship
anywhere, and this architecture is what that requirement permits. The trade-offs are real,
so they are documented rather than hidden.
