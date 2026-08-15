# Wire protocol

Version: **7** sent, **7 only** accepted (`PROTOCOL_VERSION` and
`SUPPORTED_PROTOCOL_VERSIONS` in `src/features/game/network/protocol.ts`)

Every message is JSON, travels directly over a player's WebSocket to their room, and is
validated with Zod **before it can influence any state**. Schemas are the single source of
truth; this document describes them.

There is one protocol now. Until version 5 there were two stacked on the same socket: this
one, and a relay protocol underneath it that routed frames between named peers. Routing had
nothing left to decide once the room became the authority — there is one destination — so
the lower layer is gone and the socket _is_ the session. What remains of `worker/src/protocol.ts`
is the room-code pattern, a frame-size ceiling, and the bare `ping`/`pong` strings the
Cloudflare runtime answers without waking the room.

## Design rules

1. **Clients send intents, never state.** There is no message that carries a game state from
   a client. The vocabulary makes an illegitimate claim inexpressible.
2. **Clients do not name themselves.** No client→room message carries a player id as an
   assertion of identity (`resumeRequest` names one, but must prove a token for it, and
   `roomCommand` names a _target_). The room binds a seat to the socket when a join is
   accepted and injects that id server-side.
3. **Validate first, then act.** Envelope → protocol version → room id → duplicate id →
   payload schema. Only then does a handler run.
4. **Unknown fields are dropped, not trusted.** Zod objects strip anything not in the schema,
   so an extra `{isCreator: true}` cannot smuggle privilege.
5. **Bounded everything.** Strings, arrays and numbers have maxima; a whole message is capped
   at 64 Ki UTF-16 code units — the check counts units rather than bytes, so the true byte
   ceiling is up to three times that. It is a memory bound, not a budget.

## Envelope

Every message is a flat object with these fields plus a `type` and a `payload`:

| Field             | Type           | Bounds     | Purpose                                       |
| ----------------- | -------------- | ---------- | --------------------------------------------- |
| `protocolVersion` | integer        | 0–1000     | Compatibility gate                            |
| `id`              | string         | 1–64 chars | Message id, used for de-duplication           |
| `roomId`          | string         | 3–32 chars | Room code; mismatches are ignored             |
| `senderPeerId`    | string         | 1–64 chars | Connection label, for the log only            |
| `timestamp`       | integer        | ≥ 0        | `Date.now()` at send; never used for ordering |
| `type`            | string literal | —          | Discriminator                                 |
| `payload`         | object         | per type   | Contents                                      |

`timestamp` is deliberately **not** used to order anything — clocks on separate devices are
not comparable. Ordering comes from `GameState.version`.

`senderPeerId` used to be a routable peer id — the relay addressed frames by it. Nothing is
routed now, so it is a label: clients stamp a per-tab id, the room stamps `'room'`.

De-duplication uses a bounded LRU of the last 512 message ids per connection. A WebSocket is
reliable and ordered, so duplicates are rare in practice; the guard exists for deliberate
replay by a hostile client. It is **not** what makes a move idempotent — an envelope id is
minted fresh on every send, so a deliberate re-send of the same intent has a new one. That is
`requestId`'s job, and it lives on the seat rather than on the connection, so it survives the
reconnect it exists for.

## Validation pipeline

```
parseClientMessage(raw) / parseRoomMessage(raw)
  1. not an object / array / null            -> { ok:false, error:'notAnObject' }
  2. JSON longer than 64 KiB or cyclic       -> { ok:false, error:'tooLarge' }
  3. envelope shape invalid                  -> { ok:false, error:'malformedEnvelope' }
  4. protocolVersion unsupported             -> { ok:false, error:'protocolMismatch', received }
  5. unknown `type`                          -> { ok:false, error:'unknownType', received }
  6. payload fails its schema                -> { ok:false, error:'invalidPayload', issues }
  7. otherwise                               -> { ok:true, message }
```

The two entry points are directional: `parseClientMessage` accepts only messages a client may
send, and `parseRoomMessage` only messages the room may send. A client that sends
`publicState` to the room is rejected as `unknownType` — the room has no code path that could
accept it.

Reaction to a failure:

| Failure                                                                         | Room reaction                                      | Client reaction           |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
| `notAnObject`, `malformedEnvelope`, `invalidPayload`, `unknownType`, `tooLarge` | log and ignore                                     | log and ignore            |
| `protocolMismatch`                                                              | reply `joinRejected(protocolMismatch)`, then close | surface a localised error |
| wrong `roomId`                                                                  | ignore                                             | ignore                    |
| duplicate `id`                                                                  | ignore                                             | ignore                    |

Ignoring is deliberate: a client that sends nonsense must not be able to make the room log
loudly, allocate memory or tear down the room.

## Client → room messages

| Type            | Payload                            | Notes                                                                                                                 |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `joinRequest`   | `{displayName, create?}`           | Name is 1–16 chars; the room sanitises and de-duplicates it. `create` opens the room, and is refused if it has seats. |
| `resumeRequest` | `{playerId, resumeToken}`          | Retakes an existing seat after a refresh. Token is 8–64 chars. Works for **every** seat, the creator's included.      |
| `action`        | `{action, requestId?, turnToken?}` | The only way to affect the game. See below.                                                                           |
| `roomCommand`   | `{command}`                        | A lobby power. Honoured only from the seat named by `creatorPlayerId`. See below.                                     |
| `playAgainVote` | `{agree}`                          | Only meaningful once a round has finished.                                                                            |
| `pauseRequest`  | `{paused}`                         | Asks the table to hold, out loud.                                                                                     |
| `abandonVote`   | `{agree}`                          | Ends a round by unanimous agreement of the players present.                                                           |
| `nudge`         | `{targetPlayerId}`                 | Nudges a seat that is connected and not looking.                                                                      |
| `leave`         | `{}`                               | Voluntary departure.                                                                                                  |

There is no `ping` message. Liveness is a bare `ping`/`pong` string on the socket, answered by
the Cloudflare runtime's auto-responder while the room stays hibernated — a `ping` _message_
would wake the room, on a cadence, for every player, for as long as the room lived.

### `roomCommand` payloads

```ts
| { type: 'startGame' }
| { type: 'setMaxPlayers'; maxPlayers: number }
| { type: 'setTableLanguage'; language: 'he' | 'en' }
| { type: 'setGameMode'; mode: 'classic' | 'stairs' }
| { type: 'kickPlayer'; playerId: string }
| { type: 'addBot' }
| { type: 'setStandInEnabled'; enabled: boolean }
| { type: 'setAssist'; level: 'off' | 'light' | 'medium' | 'strong'; playerIds: string[] }
| { type: 'standInNow'; playerId: string }
| { type: 'stopStandIn'; playerId: string }
| { type: 'skipAbsentTurn'; playerId: string }
| { type: 'removeFromRound'; playerId: string }
```

All but the newest used to be method calls on a local `HostSession`, which is why they were never on the
wire: the person with the buttons was, by construction, the person running the game. They are
messages now, and the room authorises each against `creatorPlayerId` — so the buttons follow a
credential rather than whichever device happens to be serving. One message type rather than
ten keeps that check in exactly one place.

If the creator's seat leaves the room entirely, the powers pass to the lowest-numbered
remaining seat, so a table can always be started.

### `action` payloads

```ts
| { type: 'playCard'; cardId: string; chosenColor?: 'red'|'blue'|'green'|'yellow' }
| { type: 'drawCard' }
| { type: 'closeTaki' }
| { type: 'passBreak' }
| { type: 'declareLastCard' }
| { type: 'catchLastCard'; targetId: string }
```

`chosenColor` is required for Change Colour and forbidden on every other card, including
the other colourless ones; the engine rejects both mistakes (`colorRequired`,
`colorNotAllowed`).

`playCard` also accepts an optional `declareLastCard: boolean`, honoured only when the play
really does leave exactly one card in hand. Nothing in the current client sends it: the
declaration opens after the card has landed, alongside the catch it exposes its owner to,
never before — see rule 8 in `docs/rules.md`. The field stays on the wire because a client
from an older build still sends it, and dropping it would silently swallow their shout.

`passBreak` declines to answer an open +3. It, and a `playCard` naming a +3 Breaker, are
accepted **from a player whose turn it is not** — and only while a +3 is open. Everything
else from another seat is `notYourTurn`, and everything at all while a +3 is open is
`awaitingBreak`.

`declareLastCard` and `catchLastCard` are the other out-of-turn actions, and they are
unconditional on the turn: both are accepted from any seat at any moment, including while a
+3 has the table frozen. `declareLastCard` requires that the sender holds exactly one card
(`nothingToDeclare`) and has not already declared it (`alreadyDeclared`), and changes nothing
but `declaredLastCard`. `catchLastCard` requires that `targetId` is somebody else who is on a
single undeclared card (`nothingToCatch`), and makes them draw the penalty. Two further
conditions on a catch are the room's rather than the engine's, and answer with the same
code: the target must be **connected**, and their hand must have been down to one card for at
least `LAST_CARD_GRACE_MS` by the **room's** clock. See `docs/rules.md`.

## Room → client messages

| Type             | Payload                                       | Notes                                                                                                                           |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `joinAccepted`   | `{playerId, resumeToken, displayName, lobby}` | The assigned seat and its rejoin secret. `displayName` may differ from the requested one after sanitising/de-duplication.       |
| `joinRejected`   | `{reason}`                                    | `roomFull \| gameInProgress \| invalidName \| protocolMismatch \| unknownSeat \| invalidResumeToken \| roomClosed \| roomTaken` |
| `lobbyState`     | `{lobby}`                                     | On any seat or health change, and once when a turn passes the nudge threshold.                                                  |
| `publicState`    | `{state}`                                     | The whole table, minus every hand.                                                                                              |
| `privateHand`    | `{hand}`                                      | **Unicast.** Only the owner's cards, on the socket bound to that seat.                                                          |
| `gameEvents`     | `{version, events}`                           | Log lines; max 64 per message.                                                                                                  |
| `actionAccepted` | `{requestId, version}`                        | **Unicast.** The only trustworthy acknowledgement — see below.                                                                  |
| `actionRejected` | `{code, requestId?}`                          | **Unicast**, an engine `RejectionCode`.                                                                                         |
| `playAgainState` | `{agreed, required}`                          | Vote progress for the next round.                                                                                               |
| `paused`         | `{pausedBy}`                                  | Somebody asked the table to wait.                                                                                               |
| `nudged`         | `{fromPlayerId}`                              | **Unicast.** It is your turn and somebody is waiting.                                                                           |
| `assistState`    | `{catchDelayMs, settings?}`                   | **Unicast, per recipient.** `catchDelayMs` is about the recipient alone; `settings` goes to the creator's socket only.          |
| `kicked`         | `{reason}`                                    | `removedByCreator \| duplicateConnection`                                                                                       |
| `roomClosed`     | `{reason}`                                    | `roomClosed`. Terminal. Sent to a socket that woke from a hibernation into a room whose record no longer parses.                |

### `assistState`, and the one thing this protocol keeps from the table

Every other fact a table decides — its size, its mode, whether robots may cover a seat — is
broadcast to everybody, on the argument that a fact about the table belongs to everybody at it.
The easements are the deliberate exception, because an easement that is announced is not an
easement (see [assist.md](assist.md)). So they never appear in `lobbySnapshot`, and travel in
a message that is built **per connection**:

- `settings` — the level and the marked seats — goes only to the socket whose player is
  `creatorPlayerId`. Not to the marked player, either.
- `catchDelayMs` goes to everybody and describes only the recipient: how long their own "never
  declared!" button waits before it works. It names nobody and reveals no list.

There is no code path that puts `settings` in a message more than one player receives, and a
worker test asserts that on the raw frames rather than on the parsed model.

`actionAccepted` cannot be inferred from the state moving forward, because in this game other
players legally act out of turn: a new snapshot may have nothing to do with my move, and
treating it as proof is how a lost action comes to look like a delivered one. It is sent
_after_ the new table, so a client's move lock is never released while its turn counter is
still one behind.

## Snapshot / event model

Both are sent, and they serve different purposes:

- **Snapshots** (`publicState`, `privateHand`) are the truth. A client renders from the newest
  snapshot it has accepted. Snapshots are idempotent, so a resend is harmless — which is what
  makes reconnection simple.
- **Events** (`gameEvents`) are the narrative: "Dana played Blue 7". They drive the game log
  and nothing else. Losing an event costs a log line, never correctness.

A client never reconstructs state by replaying events. That decision removes a whole class of
divergence bugs.

### Ordering

`publicState.state.version` and `privateHand.hand.version` are the same monotonic counter.
Clients apply a message only if `version >= lastAppliedVersion`; equal is accepted so a
deliberate resend (reconnect, resume) still lands. Versions continue across rounds — a new
deal does not restart at 1.

### Privacy invariants

- `publicGameStateSchema` has no field that can hold a hand: players carry `cardCount`, not
  cards. The only `Card` in it is `discardTop`, which is face up on the table.
- `declaredLastCard` is public on purpose, and leaks nothing: it names players who are
  already visibly on one card, and at a real table the declaration is a shout everybody
  hears.
- `plusThree` names only the player who played the +3, never the players holding a breaker.
  Publishing who can answer would leak a card from a hand; each client decides whether to
  offer the choice by looking at the hand it already has.
- `privateHand` is only ever sent with `connection.send` to one connection, never broadcast.
- A client additionally checks `hand.playerId === myPlayerId` and ignores a hand that is not
  its own, so even a buggy room cannot make a client render someone else's cards.

## Example messages

Join request (client → room):

```json
{
  "protocolVersion": 6,
  "id": "9f2c1a7b4e0d8c33",
  "roomId": "482913",
  "senderPeerId": "abc123def456",
  "timestamp": 1758000000000,
  "type": "joinRequest",
  "payload": { "displayName": "Dana" }
}
```

Join accepted (room → client):

```json
{
  "protocolVersion": 6,
  "id": "1b7e4c2a9d5f0e81",
  "roomId": "482913",
  "senderPeerId": "room",
  "timestamp": 1758000000120,
  "type": "joinAccepted",
  "payload": {
    "playerId": "pl_4f8fc9480f6e569d",
    "resumeToken": "b3d1f0a29c7e45118ab6d2c4e9f01d7a",
    "displayName": "Dana",
    "lobby": {
      "roomCode": "482913",
      "creatorPlayerId": "pl_7c1e33a90b2d4f68",
      "maxPlayers": 4,
      "phase": "lobby",
      "tableLanguage": "he",
      "players": [
        { "id": "pl_7c1e33a90b2d4f68", "name": "Noa", "isCreator": true, "health": "connected", "seat": 0 },
        { "id": "pl_4f8fc9480f6e569d", "name": "Dana", "isCreator": false, "health": "connected", "seat": 1 }
      ]
    }
  }
}
```

An action (client → room) — note there is no player id anywhere:

```json
{
  "protocolVersion": 6,
  "id": "5c8a2e1d7b3f9046",
  "roomId": "482913",
  "senderPeerId": "abc123def456",
  "timestamp": 1758000042000,
  "type": "action",
  "payload": { "action": { "type": "playCard", "cardId": "w-colorChange-0", "chosenColor": "green" } }
}
```

Public state (room → all) — card counts only:

```json
{
  "protocolVersion": 6,
  "id": "aa10bb20cc30dd40",
  "roomId": "482913",
  "senderPeerId": "room",
  "timestamp": 1758000042100,
  "type": "publicState",
  "payload": {
    "state": {
      "version": 12,
      "phase": "playing",
      "players": [
        { "id": "pl_7c1e33a90b2d4f68", "name": "Noa", "cardCount": 6 },
        { "id": "pl_4f8fc9480f6e569d", "name": "Dana", "cardCount": 7 }
      ],
      "drawPileCount": 78,
      "discardTop": { "id": "w-superTaki-0", "kind": "superTaki" },
      "discardCount": 5,
      "activeColor": "green",
      "direction": 1,
      "currentPlayerId": "pl_4f8fc9480f6e569d",
      "takiMode": {
        "color": "green",
        "playerId": "pl_4f8fc9480f6e569d",
        "cardsPlayed": 1,
        "openedWithSuperTaki": true
      },
      "pendingPlus": false,
      "pendingDraw": 0,
      "freePlay": false,
      "plusThree": null,
      "declaredLastCard": [],
      "winnerId": null
    }
  }
}
```

Private hand (room → one client only):

```json
{
  "protocolVersion": 6,
  "id": "bb11cc22dd33ee44",
  "roomId": "482913",
  "senderPeerId": "room",
  "timestamp": 1758000042110,
  "type": "privateHand",
  "payload": {
    "hand": {
      "version": 12,
      "playerId": "pl_4f8fc9480f6e569d",
      "cards": [
        { "id": "n-green-3-1", "kind": "number", "color": "green", "value": 3 },
        { "id": "a-stop-green-0", "kind": "stop", "color": "green" }
      ]
    }
  }
}
```

Events (room → all):

```json
{
  "protocolVersion": 6,
  "id": "cc12dd34ee56ff78",
  "roomId": "482913",
  "senderPeerId": "room",
  "timestamp": 1758000042120,
  "type": "gameEvents",
  "payload": {
    "version": 12,
    "events": [
      {
        "type": "cardPlayed",
        "playerId": "pl_4f8fc9480f6e569d",
        "card": { "id": "w-superTaki-0", "kind": "superTaki" },
        "resultingColor": "green"
      },
      { "type": "takiOpened", "playerId": "pl_4f8fc9480f6e569d", "color": "green", "superTaki": true }
    ]
  }
}
```

A rejection (room → one client):

```json
{
  "protocolVersion": 6,
  "id": "dd13ee24ff35aa46",
  "roomId": "482913",
  "senderPeerId": "room",
  "timestamp": 1758000042130,
  "type": "actionRejected",
  "payload": { "code": "wrongTakiColor" }
}
```

None of the examples contain anything private: no email, no device identifier, no token that
outlives the room. Peer ids are random per session, and the room code is an invitation, not a
secret.

## Rejection codes

Produced by the engine and mapped to localised strings by key `reject.<code>`:

`gameFinished`, `unknownPlayer`, `notYourTurn`, `cardNotInHand`, `illegalCard`,
`colorRequired`, `colorNotAllowed`, `mustPlayAfterPlus`, `mustAnswerDraw`, `awaitingBreak`,
`noPlusThreeOpen`, `cannotDrawDuringTaki`, `noTakiOpen`, `wildNotAllowedInTaki`,
`wrongTakiColor`, `notEnoughPlayers`, `tooManyPlayers`, `duplicatePlayerId`.

A test asserts every code has a Hebrew and an English message, so an unlocalised rejection
cannot reach a player.

`mustPlayAfterPlus` is retired: a Plus obligation may be paid from the draw pile, so nothing
emits it any more. It stays in the vocabulary because a rejection code is part of a schema,
and removing a value costs more than leaving one unused — a client built against a shorter
enum would fail to parse a message from a room that still knew the longer one.

## Version 6: what moving the game to the room changed

Version 5 and earlier had two versions in play at once — a table could be mixed, so every
field added in 4 was optional and a version-3 reader simply lost the behaviour. That
concession belonged to the topology: both sides of a table were browsers loading a static,
per-browser-cached site, so a reload fetched a new bundle while everybody else kept the old.

There is one server now, always the newer of the two, so `SUPPORTED_PROTOCOL_VERSIONS` holds
exactly one entry and will keep doing so. A stale tab is told to reload, which is the honest
answer and the one the gate exists to give.

### Removed

| What                                | Why                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lobby.hostPeerId`                  | There is no host peer to address.                                                                       |
| `lobby.generation`                  | Host generations existed only so a client could follow a handover.                                      |
| `handoffOffer`, `handoffAccepted`   | The room does not move, so there is nothing to hand over.                                               |
| `hostClosed(restarting \| handoff)` | Both meant "this is not the end" — a distinction only a host needed. A room that says it is closed, is. |
| `ping` / `pong` messages            | Liveness is a bare socket frame the runtime answers without waking the room.                            |
| `ConnectionHealth`'s `'unstable'`   | It meant "we are counting missed probes and are not sure". The runtime reports a closed socket.         |
| `joinRequest.wantsSpectator`        | Reserved for years, never implemented, and no clearer for having been kept.                             |

### Renamed and narrowed

| Before                  | After                      | Note                                                                          |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| `hostPlayerId`          | `creatorPlayerId`          | Names the seat with the lobby buttons, not the device running the game.       |
| `player.isHost`         | `player.isCreator`         | The same narrowing, per seat.                                                 |
| `hostClosed`            | `roomClosed`               | One reason, `roomClosed`, and terminal.                                       |
| `kicked(removedByHost)` | `kicked(removedByCreator)` | Whoever holds the lobby buttons, not an authority.                            |
| `parseHostMessage`      | `parseRoomMessage`         | And `hostMessageSchema` → `roomMessageSchema`, `HostMessage` → `RoomMessage`. |

Several `lobby` fields that were optional purely so an older reader could ignore them are now
**required**: `sentAt`, `seatGraceMs`, `pausedBy`, `waitingFor`, `waitingReason`,
`waitingSince`, `abandonVotes`, `standInEnabled`. Optionality that is genuinely "absent means
false" — `player.left`, `bot`, `standIn`, `robotPlayed`, `absentSince` — stays.

### Added

| Direction     | What                      | Purpose                                                                                                                           |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| client → room | `joinRequest.create`      | `{maxPlayers, tableLanguage}`, accepted only while the room has no seats. Replaces claiming a peer id derived from the room code. |
| client → room | `roomCommand`             | The ten lobby powers, authorised against `creatorPlayerId`. See above.                                                            |
| room → client | `joinRejected(roomTaken)` | The code is already a room. The client draws another, as it did when the relay refused an id claim.                               |

### What survived unchanged, and why that mattered

The whole snapshot/event model, the envelope, `requestId`, `turnToken`, `actionAccepted`, the
rejection vocabulary, and both projections (`PublicGameState`, `PrivateHandView`). Reusing
them is why `clientSession.ts` kept its shape through a change that deleted the class opposite
it — the reasoning is recorded in [server-game-plan.md](server-game-plan.md) §2.

### Turn-scoped and out-of-turn intents

`turnToken` is checked for `playCard` in turn, `drawCard` and `closeTaki`. It is deliberately
**not** checked for `declareLastCard`, `catchLastCard`, `passBreak`, or a breaker played into
an open `+3`: those are legal at any moment, they race each other on purpose, and gating them
on a turn would hand every tie to whichever player broke the rule.

## Version 7: game modes, and a score that outlives a round

Two additions, both of which change meaning rather than merely adding a field — which is why
the version moved rather than the fields being made quietly optional.

**The mode.** A round now carries a `mode`: `classic`, or `stairs`, where an empty hand is a
step down a staircase rather than a win. Two peers on either side of this disagree about the
single most important thing at a table — whether the round is over — so a stale tab would
announce a winner and then watch the game carry on without it. See
[rules.md](rules.md#game-modes).

**The score.** A seat carries `wins`: rounds it has won since the room opened. It belongs to
the room and to the seat, so it lives exactly as long as they do.

### Added

| Direction     | What                               | Purpose                                                                                                    |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| client → room | `joinRequest.create.gameMode`      | The mode chosen on the create-a-table screen. Absent means `classic`.                                      |
| client → room | `roomCommand(setGameMode)`         | Changes the mode for the next deal. Refused once cards are out; a round keeps the mode it was dealt under. |
| room → client | `lobby.gameMode`                   | How the next round will be won. Every seat is told, not only the one that chose.                           |
| room → client | `lobby.players[].wins`             | Rounds this seat has won since the room opened.                                                            |
| room → client | `publicState.mode`                 | How the round _on the table_ is won. Distinct from `lobby.gameMode`, which describes the next deal.        |
| room → client | `publicState.players[].stairsStep` | Hands that seat has emptied, 0–8. Sent only in a stairs round: in a classic one there is no staircase.     |
| room → client | `gameEvents(stairsAdvanced)`       | `{playerId, stage, dealt}` — a hand finished, and the size of the one that replaced it.                    |

Every one of these is `optional` on the wire, and absent always reads as the game before the
modes existed: `classic`, no staircase, nobody has won anything. That is what keeps a stored
round written by an older deployment readable — see the note on `emptySince` in
`worker/src/storage.ts`, which is the same rule applied to durable state.

## Version compatibility strategy

`protocolVersion` is a single integer, bumped on **any** breaking change to a message shape
or its meaning.

- The version is read in a **loose first pass**, before the strict schema. A peer running a
  different version therefore gets a clear `protocolMismatch` rather than a confusing
  validation error.
- The room replies `joinRejected(protocolMismatch)` and closes; the client shows "this page is
  running an older version of the game — reload to get the current one".
- There is no negotiation and no backwards compatibility shim. Every client loads the same
  static site from the same URL and talks to one deployed worker, so a mismatch only happens
  when a tab has been open across a release. A reload fixes it, which is a better outcome than
  maintaining translation layers between versions of a private game.
- Additive, optional fields do **not** need a bump: unknown fields are stripped, and an older
  peer simply ignores them. `wantsSpectator` is an example of a field reserved this way.
- A **rule** change does need one, and it cannot be softened by accepting the older version
  as 4 did with 3. Version 5 — the King cancelling a +2 run — is the first of those: two peers
  on different sides of it would refuse each other's legal moves, so the older one is told to
  reload rather than left to argue.
