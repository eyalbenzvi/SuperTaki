# Disconnect resilience — plan of record

Goal: **a disconnect is a pause, never the end of a game.** Every item is in-repo only: no
account, no server, no TURN credential to obtain, no environment variable set elsewhere.
Constraints kept: static site on GitHub Pages, exactly zero third-party cost, `engine/` stays
pure and deterministic, existing layering preserved.

This is v2. v1 was reviewed by three external reviewers — a PeerJS/WebRTC engineer, a
network/connectivity engineer, and a multiplayer game developer — and substantially rewritten.
Where they disagreed, the resolution and its reasoning are recorded below.

---

## What the review changed

### Cut from v1

- **Automatic mid-round host failover, and the whole digest chain.** All three reviewers
  independently rejected it. It is unsound with the primitives this app has: PeerJS's
  signalling socket and its data channels have independent lifetimes, so a host that loses only
  its broker socket keeps serving every already-connected player while being unable to accept a
  new one — and a client that cannot reach it has no way to distinguish that from death.
  Clients have no peer-to-peer mesh, so "the host is dead" is a single unverifiable
  observation. Two live hosts at different generations, both serving real players, both holding
  cryptographically valid digests, is reachable. The digest chain also proves only authenticity,
  not recency: a successor could take over at version _V−k_ with a digest everyone already
  holds and silently rewind the round.
  **Replaced by:** the host coming back (S8) plus explicit handover from a _living_ host (S13),
  which together cover host refresh, host tab close, and "I have to go" — the overwhelming
  majority of real host loss. True host death now ends the round honestly instead of corrupting
  it, and `docs/rules.md` says a round is scoreless anyway.
- **The heartbeat Web Worker.** Chrome freezes background tabs _including their dedicated
  workers_, and iOS Safari suspends the whole page and commonly tears down the
  `RTCPeerConnection` outright. It helps only the desktop-hidden-tab case, which the late-tick
  rule (S6) already handles correctly and for free. `wakeLock.ts` is kept — thirty lines, real
  value on a phone lying on a table.
- **The `localStorage` mirror of the host snapshot.** It would write every hand and the deck
  order to persistent storage to recover from the rare crash-with-tab-close.
  `sessionStorage` survives a reload, which is the common case, and dies with the tab.
- **Deleting a seat mid-round.** Replaced by marking it `left` (S9), which dissolves four
  separate defects at once — see below.
- **Host-side `baseVersion` rejection and the `actionStale` message.** `version` increments on
  every accepted command, including the out-of-turn ones (`declareLastCard`,
  `catchLastCard`), so a strict check would reject legal moves as a matter of routine.

### Resolved disagreements

| Question                   | Positions                                                                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bump `PROTOCOL_VERSION`?   | PeerJS eng: no — on a static site the reloading tab fetches the new bundle while others keep the cached old one, so a resilience release makes resuming incompatible for everyone else. Network eng: yes, and spend it.                            | **Both.** `PROTOCOL_VERSION = 4` for what we send, `SUPPORTED_PROTOCOL_VERSIONS = [3, 4]` on receive, every new field optional. Zod strips unknown keys, so a v3 reader already tolerates v4 additions.                                                                                                                                                                                                                                                              |
| Staleness check on actions | PeerJS eng: drop it, client-side only, add an explicit ack. Game dev: replace with a turn token, checked only for turn-scoped intents. Network eng: make it mandatory.                                                                             | **Turn token** (`{currentPlayerId, turnSeq}`, `turnSeq` bumped only on `turnChanged`), checked only for `playCard`-in-turn / `drawCard` / `closeTaki`; **never** for `declareLastCard`, `catchLastCard`, `passBreak` or a breaker play — those are predicate-based and the engine already answers them correctly against current state. Plus an explicit `actionAccepted {requestId, version}`: an ack can never be inferred from version movement in this rule set. |
| Absent-turn grace          | Network eng: 90 s, because a WiFi→cellular handover is 5–40 s and a returning player must not have lost a turn. Game dev: 8 s when the channel is provably closed — the host already knows, waiting learns nothing — and 0 s after the first skip. | **Synthesis.** The harm of a skip is small _because a skip draws no cards_ (S9), so a short window is affordable: **12 s** when the channel is closed, **30 s** when merely unstable, **0 s** after a seat's first skip until it reconnects — and suppressed entirely if a `resumeRequest` for that seat arrived in the last 20 s. Observed reconnection attempts are far stronger evidence than silence, and cost nothing to record.                                |
| Seat grace                 | v1 said 3 min on the host, with a separate 10 min client deadline.                                                                                                                                                                                 | **One authority.** `seatGraceMs = 5 min` is the host's number, broadcast in the lobby snapshot; the client _derives_ its own deadline as `seatGraceMs − 30 s`. Two constants that must agree eventually will not; one constant plus a subtraction cannot disagree.                                                                                                                                                                                                   |

### Added — the reviewers found five defects v1 had not noticed

1. **The repo deletes the free TURN relays it already ships with.** `peerTransport.ts:140-152`
   passes `config: {iceServers}`, which _replaces_ PeerJS's `DEFAULT_CONFIG` wholesale — and
   that default contains `turn:eu-0.turn.peerjs.com:3478` and `turn:us-0.turn.peerjs.com:3478`
   (verified in `node_modules/peerjs/dist/bundler.mjs:128-143`). The CSP already permits
   `turn:`. Merging instead of replacing restores relay candidates for symmetric NAT, CGNAT and
   IPv6-only cellular — no account, no credential, no server, one line. `docs/architecture.md`
   describes as an immovable limitation something the code was creating.
2. **`Peer.connect()` returns `undefined` when the peer is disconnected from the broker**
   (bundler.mjs:1659-1662), and a lost signalling socket sets exactly that state.
   `peerTransport.ts:221` stores it and `:248` calls `.once()` on it — a synchronous
   `TypeError` inside the promise executor. Every reconnect path funnels through here, and a
   wake after a phone unlock is precisely when signalling is down.
3. **The `reconnect()` loop is unbounded.** `peerTransport.ts:198-207` calls `peer.reconnect()`
   on every `disconnected` event with no backoff and no cap. `reconnect()` reuses the same id;
   if it has been taken, the server answers `ID-TAKEN` → `_abort` → and because
   `_lastServerId` is set, `_abort` calls `disconnect()` rather than `destroy()`
   (bundler.mjs:1722-1727) → which emits `disconnected` again. Infinite tight loop, one
   WebSocket per iteration, against a donated service.
4. **A lost `joinAccepted` is unrecoverable, and every failed join leaks a seat.**
   `handleJoinRequest` returns silently when the record already has a `playerId`
   (`hostSession.ts:421-424`), so a client re-sending after a lost accept gets nothing, ever.
   Its retry then trips the duplicate-connection path, which sets `existing.playerId = null`
   (`:307`) — after which `handleConnectionClosed` bails at `:334` and the seat is **never**
   removed. Each cycle costs one seat against `maxPlayers`.
5. **A client that received `hostClosed` can never come back.** `closeWith` sets
   `destroyed = true` and `teardown()` destroys the transport (`clientSession.ts:402-407`,
   `:455-467`), and `retry()` returns immediately when destroyed. Preserving the credential and
   extending the backoff do not un-latch the session — so S8's "clients reconnect on their own"
   was impossible as written.

And four the game reviewer found in v1's own new rules — v1's `skipTurn` was rejected by the
engine in two of the states it claimed to cover (after a King, and after a Plus while holding a
legal card: `engine.ts:602-609` with `rules.ts:44`), it double-advanced the seat pointer for a
trailing Stop (`engine.ts:585-590`, `:324-329`), it could not even detect the worst stall in the
game (an absent seat inside a `+3` window is _not_ the current player, so a turn-based trigger
never fires), and auto-passing for that seat would have published who holds a breaker — the one
thing `docs/rules.md` promises never to reveal.

### Found in review of the delivered work, and fixed

The plan survived contact; several of the things built to it did not. What the two code reviews
and the QA pass turned up, in the order they were fixed:

1. **The reconnect loop died after one attempt.** `connecting` was released only in `finally`,
   and `scheduleRetry` refuses to arm a timer while a connect is in flight — so the first
   failure scheduled nothing and the session sat in `reconnecting` for ever, with no attempt, no
   deadline and nothing said to the player. The worst possible shape for a bug in the machinery
   whose whole purpose is to keep trying.
2. **A dead channel was promoted back to healthy after the host slept.** A late watchdog tick
   clears the probe record — those questions were asked into a gap. But "nothing has convicted
   them yet" was then read as health, so a black-holed seat became `connected` again on the
   first ordinary tick after every suspension, and the table froze on a player long gone. Health
   is now an _answered_ probe, never merely an unrefuted one.
3. **The fault hooks the memory transport gained were never driven**, and one of them was
   unfaithful: a `hang` ignored the budget it was passed, so a caller with a deadline bug looked
   fine in tests and hung on a phone. The transport now honours the budget, the client enforces
   it a second time on its own side, and both are exercised.
4. **The nudge shipped dead at both ends.** It is decided from `sentAt - waitingSince`, both the
   host's own readings so that clock skew cancels — which also meant the only snapshot carrying
   a new `waitingSince` was built in the tick that set it, so the difference every client ever
   saw was zero and the button never appeared. And the receiving half wrote to the store and
   rendered nothing. The host now re-broadcasts once per idle turn, at the threshold, and the
   player who was nudged is actually told.
5. **A room could be reinstated after the player let it go.** The reclaim loop checked for
   abandonment on the way in but not on the way out, and the attempt in flight is the one most
   likely to succeed — so "forget it" pressed at the wrong moment republished the room a moment
   later. It also left `busy` set, leaving a spinner for a room nobody was reclaiming.
6. **Three tests passed for reasons unrelated to what they claimed.** A seat-leak test that
   closed each channel before opening the next, so the duplicate path it named never ran; a
   `Peer.connect() === undefined` test that rejected earlier, on the signalling check, and never
   reached the guard; and a superseded-session test that stood up a second room, adopted
   nothing, destroyed nothing, and asserted after nothing had happened. All three now drive the
   path they describe, and the last one covers taking over a room end to end.
7. **A host who handed the room over was left on a lobby that no longer existed.** Handing over
   ends this device's session for the most voluntary reason there is, and a voluntary ending
   draws no dialog — so nothing navigated, and the outgoing host sat on a lobby screen with
   `lobby: null` behind it and nothing to press.
8. **The seat-hold countdown was rebuilt several times a minute** — its key included the
   snapshot time, and the host re-broadcasts on every accepted command — which dropped keyboard
   focus mid-interaction. As a live region it also read the remaining time aloud once a second,
   burying every other event at the table. It now anchors once and announces once.

---

## The work, in order

Each step lands as its own commit and must leave `npm run verify` green.

### S1 — Foundations: one timeout hierarchy, one version policy

Constants move into `src/features/game/network/timing.ts` as the single source of truth. Seat
deadlines are the host's and travel in the lobby snapshot; the client derives.

| Constant                                       | Value                                  | Why                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROBE_INTERVAL_BUSY_MS`                       | 5 s                                    | While an action is pending or it is the local player's turn.                                                                                                           |
| `PROBE_INTERVAL_IDLE_MS`                       | 15 s                                   | A fixed 5 s cadence never lets a cellular modem reach RRC-idle; a turn-based card game does not need sub-second detection.                                             |
| `UNSTABLE_AFTER_MISSES`                        | 3                                      | Was 9 ms-based, i.e. under two intervals — it convicted on one lost round trip.                                                                                        |
| `PEER_SILENT_AFTER_MS`                         | max(6 × interval, 30 s)                | RFC 7675 ICE consent freshness expires at 30 s; before that the browser's own agent has not given up, so neither should we.                                            |
| `CHANNEL_DEAD_MS`                              | 45 s                                   | Force-close and reconnect: 30 s consent + margin.                                                                                                                      |
| `PROBE_DEADLINE_MS`                            | 3 s                                    | The post-wake liveness probe. A wake needs an answer now, not a grace period.                                                                                          |
| `SIGNALLING_READY_MS`                          | 12 s, re-armable                       | The broker answers in ~1 s or it is down.                                                                                                                              |
| `CONNECT_TIMEOUT_FIRST_MS` / `_RETRY_MS`       | 8 s / 20 s                             | 15 s flat was too long for the attempt a user is watching and too short for a _relayed_ pair on slow cellular.                                                         |
| `JOIN_TIMEOUT_MS`                              | 15 s, non-terminal                     | Must exceed the host's own turnaround.                                                                                                                                 |
| `RECONNECT_BACKOFF_MS`                         | 0, 1, 2, 5, 10, 20, 30 s, ±30 % jitter | Attempt 0 immediate: a wake or an `online` event is new information. Cap 30 s keeps us a good citizen of a donated broker.                                             |
| `LOBBY_GRACE_MS`                               | 30 s                                   | The lobby had **no** grace at all — a seat was spliced immediately (`hostSession.ts:341-344`) — and the lobby is exactly where phones sleep.                           |
| `SEAT_GRACE_MS`                                | 5 min, broadcast                       | Must exceed worst realistic recovery: 40 s handover + up to 75 s broker id-hold + a backoff round.                                                                     |
| `ABSENT_TURN_GRACE_CLOSED_MS` / `_UNSTABLE_MS` | 12 s / 30 s                            | See the resolution table.                                                                                                                                              |
| `HOST_ID_RETRY_WINDOW_MS`                      | 75 s                                   | The PeerJS server's `alive_timeout` defaults to 60 s, so a hard-killed host can still reclaim its own room code — v1 conceded the code (and every invite) after ~30 s. |
| `HOST_SELF_DEMOTE_MS`                          | 90 s                                   | A host that cannot re-register tells its clients honestly instead of pretending.                                                                                       |
| `ACTION_LOCK_MS`                               | 20 s                                   | 5 s was shorter than a single reconnect attempt, so any hiccup released the lock and the player tapped again.                                                          |

### S2 — Transport hardening

Merge PeerJS's default ICE config rather than replacing it (restores the free relays). Guard
`connect()` against `undefined`. Re-armable `socketReady`, awaited by `connect()` on its own
budget, so a handover retry stops burning a full connect timeout doing nothing. Jittered,
capped `reconnect()` that stops on `idUnavailable`. `close()` on every rejection path — each
leak was a live `RTCPeerConnection` that had already fired STUN and TURN allocations. Expose
`signalingLost`/`signalingRestored`, `bufferedAmount` and `getDiagnostics()` so sessions can
finally tell "broker down" from "peer gone", and treat `iceStateChanged === 'disconnected'` as
unstable rather than waiting for `failed`.

### S3 — A transport that can actually fail

`broadcast` and `memory` model none of the failures being fixed: `open` is a boolean only ever
flipped by an explicit `close()`, delivery is synchronous and ordered, nothing is ever
half-open. Every test of S6–S8 would go green while proving nothing. So the memory transport
gains fault injection: black-holed sends while `open` stays true, delayed and duplicated
delivery, a second channel opening while the first is half-open, and a `connect()` that hangs.

### S4 — Diagnostics

A 500-entry ring in `sessionStorage`, ping/pong excluded, failure and takeover events never
evicted, shown in Settings with a copy button, transmitted nowhere. Structured fields, because
free-form strings cannot answer the question: the selected candidate pair's local/remote
`type` (`host`/`srflx`/`relay`) — the entire difference between "we never had a path" and "our
path died" — the candidate types ever gathered, ICE state transitions, the paired
`Date.now()`/`performance.now()` delta across a gap (a wall-clock jump with missing ticks is
suspension; no jump is a network event), `visibilityState` and whether `freeze`/`resume` fired,
`navigator.connection.effectiveType` changes where available, and whether a `hostClosed`
arrived _before_ the channel died.

### S5 — Connectivity pre-check

One local `RTCPeerConnection`, no broker and no peer: gather candidates and read them. No
`srflx` at all means outbound UDP is blocked. `srflx` but no `relay` means the relay is
unreachable. Comparing the `srflx` port reported by two different STUN servers detects
address/port-dependent (symmetric) NAT — which `docs/architecture.md` implies is undetectable.
A one-second, zero-cost check that turns "it just spins" into a straight answer _before_
invites go out, and is the honest doorway to hot-seat.

### S6 — Lifecycle, watchdog, heartbeat

One `src/lib/lifecycle.ts` folding `visibilitychange`, `pageshow` (including `persisted`),
`pagehide`, `freeze`, `resume`, `online` and `offline` into a single subscription. A watchdog
that judges liveness by wall clock, not by tick count: a tick late by more than 3× the interval
means _we_ slept, so nobody is convicted — but the response is an immediate probe with a 3 s
deadline and, on failure, a reconnect with zero backoff, because if the tab really was
suspended the channel is probably already dead (ICE consent expires at 30 s) and extending
grace is the opposite of what a woken tab needs. Pongs are correlated by nonce, so _N
unanswered probes_ is the evidence rather than wall-clock silence — which today is satisfied by
any unrelated broadcast (`clientSession.ts:315`). Probes are suppressed when traffic already
flowed, and the interval is adaptive. `navigator.onLine` becomes a hint that lengthens backoff,
never a stop: it is `true` behind a captive portal and it flaps during handover. Real
reachability comes from a same-origin `fetch`, which the existing CSP permits.

### S7 — Reconnection and joining

Single-flight connects with a generation guard, and `detachConnection` closes what it drops —
without which S6's "reconnect now on wake" turns a rare race into the common path, producing
two `resumeRequest`s and a `kicked(duplicateConnection)` storm. Idempotent join. Seat leak
fixed. Non-terminal join timeout. The host never kicks an unseated record. `hostRestarting` as
a distinct, non-terminal close reason. The resume credential survives everything except an
explicit leave or removal, and carries the host generation.

### S8 — The host comes back

Zod-validated snapshot in `sessionStorage`: small fields eagerly, the full game throttled, and
flushed on `pagehide`. Restore is a constructor option, because `hostPeerId` and
`localPlayerId` are `readonly` and the latter is otherwise freshly minted — which would make
every host move be rejected as `unknownPlayer` and the host's own hand render empty. It
restores `versionFloor` too, or the returning host broadcasts versions clients discard as
stale. Reclaiming the same room code is attempted for 75 s, and `idUnavailable` is
disambiguated rather than guessed: with a snapshot for that code it is our own stale socket, so
retry; without one it is a genuine collision in a 409,600-code space, so take a new code.
`pagehide` sends `hostRestarting` on the still-live channels, turning an ambiguous silence into
an explicit signal. A host that cannot re-register for 90 s self-demotes and says so.

### S9 — The engine learns about absence

`skipTurn` is its own transition, never a synthesised `drawCard`. Its default is a **pure skip
with no draw** — a disconnect is not a decision, and drawing a card per orbit would leave a
returning player four cards down after a three-minute hold, making the seat-hold promise
theatre. The one thing that must not evaporate is an obligation _someone else_ created:
`pendingDraw` is paid in full, or pulling the plug becomes the cheapest answer to an eight-card
run. The full rule table is implemented literally from the review, including the
Taki-close case analysis (the sequence's last card can only be a number, Taki, Super Taki,
Stop, Change Direction, +2 or Plus — a colourless card cannot end a sequence — and only Plus
leaves the turn with the absent player).

Seats are **marked `left`, never deleted**. That single decision removes: the dangling
`takiMode.playerId` that can never be closed and never be drawn out of (a permanent deadlock);
the `plusThree.awaiting` entry that can never empty, freezing every seat forever; the
`currentPlayerIndex` rebasing bug when a seat before the current one is removed; the
`publicGameStateSchema.players.min(2)` violation that would make the final broadcast
unparseable for every client; and the vanishing of a player from the standings they were
winning. Card conservation then holds trivially — no reshuffle, no rng consumption, no
draw-pile jump to explain.

Below `MIN_PLAYERS` remaining, the round is **abandoned**: `winnerId: null`,
`endReason: 'abandoned'`, standings shown, no winner banner. "Last player standing wins" would
have handed a 2-player host the round for a 20 s blip. The starting seat also rotates by round,
because `createGame` hard-codes index 0 and the host holds seat 0 forever.

### S10 — The table stops freezing, and stays humane

Immediate auto-pass for an absent seat inside a `+3` window, emitting no event that names it.
Auto-skip on the timings resolved above, cancelled if the player returns inside the window and
granting them a full fresh turn. An absent player is **not catchable** on last card — they
cannot declare, so absence would otherwise convert a social rule into free farming at four
cards an orbit. `waitingFor` becomes first-class table state instead of every screen inferring
it. A pause any player can request and everyone can see, and a _unanimous_ vote of the seats
still present to abandon the round — unanimity rather than a majority because abandoning is
irreversible and a bare majority would let two players end a four-player game over the other
two's objection — which is what a real table does, and it removes most of the _need_ for failover. A soft
nudge for a player who is connected but not looking, which is ten times more common than a
disconnect and feels identical. And the play-again flow stops silently stalling when the vote
can no longer pass, stops destroying resume tokens it just preserved, and offers a retired seat
a fresh join instead of a dead end.

### S11 — A move is never lost, and never applied twice

`requestId` in the action payload, minted once by the store — not the envelope id, which is
freshly generated on every send and so cannot match a replay. Seat-level dedup keyed on it,
persisted **into the snapshot**, or a host restore plus a client replay double-applies an
action; a replayed `catchLastCard` is eight cards. A known `requestId` is answered with
`actionAccepted` plus a state re-send, never re-applied. Turn token where it belongs and
nowhere else. Client dedup session-scoped and never reset, plus the missing version floor on
`gameEvents`, or a post-reconnect replay duplicates every line in the log.

### S12 — Hot-seat, the mode that cannot disconnect — **NOT DELIVERED**

> **Deferred, and not shipped in this batch.** It is the one workstream here with no
> dependency on anything else, and it is a mode rather than a repair: a new session type over
> the engine, a curtain, a rewritten `+3` window and a rules change for the last-card catch.
> Landing it half-built would be worse than not landing it, and the resilience work it was
> queued behind now stands on its own. The capability-interface refactor it needs — replacing
> the `session instanceof HostSession` checks in the store — is also still outstanding.
> Recorded here rather than quietly dropped, so nobody reads the plan after the merge and
> assumes it exists.

A capability interface first, replacing the five `session instanceof HostSession` checks, then
`LocalSession` over the engine with no transport. The curtain _clears_ the outgoing hand from
the DOM rather than covering it. During a `+3` window every seat is polled in order —
including seats with nothing to answer — because passing the phone only to the awaited seats
would announce who holds a breaker. Declaration is automatic and the catch is dropped, which is
a rules change and goes in `docs/rules.md`. All absence machinery is hard-disabled.

### S13 — Voluntary handover

The host's leave dialog offers "העבר אחסון" instead of only closing the room. The state travels
**once, at handover**, not per commit — v1's continuous snapshot was ~1 MB per round onto one
player's cellular data, and the whole verification apparatus existed only because the departing
host might be lying. Here it is alive, cooperating, and vouching on an already-trusted channel.

### S14 — Documentation

`docs/architecture.md` limitations 1, 3, 6 and 7 rewritten. `docs/protocol.md` for every new
field. `docs/threat-model.md` for the snapshot and for what a successor can see.
`docs/rules.md` — fix the contradiction where the English decision table says the last-card
catch is implemented while the Hebrew table at line 545 still says `לא מיושם`, and record the
absent-player and hot-seat rules.

---

## Explicitly out of scope, and why

- **Hot-seat (S12).** Deferred; see the marker on that section.

- **Automatic mid-round host failover.** See above. It needs an at-most-one-host invariant that
  this topology cannot provide without an authority, and a half-correct version silently
  corrupts games — which is exactly what `docs/architecture.md` promised not to do.
- **TURN beyond what PeerJS already bundles.** The bundled relays are UDP/3478 only, with no
  `turns:`/443 entry, so a network blocking outbound UDP entirely still fails. Fixing that
  needs a relay of our own, which needs money or work outside this repository.
- **Any backend.** Unchanged.
