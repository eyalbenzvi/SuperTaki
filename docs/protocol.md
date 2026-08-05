# Wire protocol

Version: **5** sent, **5 only** accepted (`PROTOCOL_VERSION` and
`SUPPORTED_PROTOCOL_VERSIONS` in `src/features/game/network/protocol.ts`)

Every message is JSON, travels over a WebRTC data channel with `serialization: 'json'`, and
is validated with Zod **before it can influence any state**. Schemas are the single source of
truth; this document describes them.

## Design rules

1. **Clients send intents, never state.** There is no message that carries a game state from
   a client. The vocabulary makes an illegitimate claim inexpressible.
2. **Clients do not name themselves.** No client→host message carries a player id (except
   `resumeRequest`, which must prove a token). The host binds a seat to the connection at
   join time and injects that id server-side.
3. **Validate first, then act.** Envelope → protocol version → room id → duplicate id →
   payload schema. Only then does a handler run.
4. **Unknown fields are dropped, not trusted.** Zod objects strip anything not in the schema,
   so an extra `{isHost: true}` cannot smuggle privilege.
5. **Bounded everything.** Strings, arrays and numbers have maxima; a whole message is capped
   at 64 KiB.

## Envelope

Every message is a flat object with these fields plus a `type` and a `payload`:

| Field             | Type           | Bounds     | Purpose                                       |
| ----------------- | -------------- | ---------- | --------------------------------------------- |
| `protocolVersion` | integer        | 0–1000     | Compatibility gate                            |
| `id`              | string         | 1–64 chars | Message id, used for de-duplication           |
| `roomId`          | string         | 3–32 chars | Room code; mismatches are ignored             |
| `senderPeerId`    | string         | 1–64 chars | Transport-level id, for diagnostics only      |
| `timestamp`       | integer        | ≥ 0        | `Date.now()` at send; never used for ordering |
| `type`            | string literal | —          | Discriminator                                 |
| `payload`         | object         | per type   | Contents                                      |

`timestamp` is deliberately **not** used to order anything — clocks on separate devices are
not comparable. Ordering comes from `GameState.version`.

De-duplication uses a bounded LRU of the last 512 message ids per connection. WebRTC data
channels are reliable and ordered, so duplicates are rare in practice; the guard exists for
resends after a reconnect and for deliberate replay by a hostile peer.

## Validation pipeline

```
parseClientMessage(raw) / parseHostMessage(raw)
  1. not an object / array / null            -> { ok:false, error:'notAnObject' }
  2. JSON longer than 64 KiB or cyclic       -> { ok:false, error:'tooLarge' }
  3. envelope shape invalid                  -> { ok:false, error:'malformedEnvelope' }
  4. protocolVersion unsupported             -> { ok:false, error:'protocolMismatch', received }
  5. unknown `type`                          -> { ok:false, error:'unknownType', received }
  6. payload fails its schema                -> { ok:false, error:'invalidPayload', issues }
  7. otherwise                               -> { ok:true, message }
```

The two entry points are directional: `parseClientMessage` accepts only messages a client may
send, and `parseHostMessage` only messages a host may send. A client that sends `publicState`
to the host is rejected as `unknownType` — the host has no code path that could accept it.

Reaction to a failure:

| Failure                                                                         | Host reaction                                      | Client reaction           |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
| `notAnObject`, `malformedEnvelope`, `invalidPayload`, `unknownType`, `tooLarge` | log and ignore                                     | log and ignore            |
| `protocolMismatch`                                                              | reply `joinRejected(protocolMismatch)`, then close | surface a localised error |
| wrong `roomId`                                                                  | ignore                                             | ignore                    |
| duplicate `id`                                                                  | ignore                                             | ignore                    |

Ignoring is deliberate: a peer that sends nonsense must not be able to make the host log
loudly, allocate memory or tear down the room.

## Client → host messages

| Type            | Payload                          | Notes                                                                                                            |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `joinRequest`   | `{displayName, wantsSpectator?}` | Name is 1–16 chars; the host sanitises and de-duplicates it. `wantsSpectator` is reserved and currently ignored. |
| `resumeRequest` | `{playerId, resumeToken}`        | Retakes an existing seat after a refresh. Token is 8–64 chars.                                                   |
| `action`        | `{action}`                       | The only way to affect the game. See below.                                                                      |
| `playAgainVote` | `{agree}`                        | Only meaningful once a round has finished.                                                                       |
| `leave`         | `{}`                             | Voluntary departure.                                                                                             |
| `ping` / `pong` | `{nonce}`                        | Heartbeat.                                                                                                       |

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
conditions on a catch are the host's rather than the engine's, and answer with the same
code: the target must be **connected**, and their hand must have been down to one card for
at least `LAST_CARD_GRACE_MS` by the **host's** clock. See `docs/rules.md`.

## Host → client messages

| Type             | Payload                                       | Notes                                                                                                                     |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `joinAccepted`   | `{playerId, resumeToken, displayName, lobby}` | The assigned seat and its rejoin secret. `displayName` may differ from the requested one after sanitising/de-duplication. |
| `joinRejected`   | `{reason}`                                    | `roomFull \| gameInProgress \| invalidName \| protocolMismatch \| unknownSeat \| invalidResumeToken \| roomClosed`        |
| `lobbyState`     | `{lobby}`                                     | On any seat or health change, and once when a turn passes the nudge threshold.                                            |
| `publicState`    | `{state}`                                     | The whole table, minus every hand.                                                                                        |
| `privateHand`    | `{hand}`                                      | **Unicast.** Only the owner's cards.                                                                                      |
| `gameEvents`     | `{version, events}`                           | Log lines; max 64 per message.                                                                                            |
| `actionRejected` | `{code, requestId?}`                          | **Unicast**, an engine `RejectionCode`.                                                                                   |
| `playAgainState` | `{agreed, required}`                          | Vote progress for the next round.                                                                                         |
| `kicked`         | `{reason}`                                    | `removedByHost \| duplicateConnection`                                                                                    |
| `hostClosed`     | `{reason, generation?}`                       | `hostLeft \| roomReset \| restarting \| handoff` — only the first two are terminal; see below.                            |
| `ping` / `pong`  | `{nonce}`                                     | Heartbeat.                                                                                                                |

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
  its own, so even a buggy host cannot make a client render someone else's cards.

## Example messages

Join request (client → host):

```json
{
  "protocolVersion": 1,
  "id": "9f2c1a7b4e0d8c33",
  "roomId": "482913",
  "senderPeerId": "abc123def456",
  "timestamp": 1758000000000,
  "type": "joinRequest",
  "payload": { "displayName": "Dana" }
}
```

Join accepted (host → client):

```json
{
  "protocolVersion": 1,
  "id": "1b7e4c2a9d5f0e81",
  "roomId": "482913",
  "senderPeerId": "crush-482913",
  "timestamp": 1758000000120,
  "type": "joinAccepted",
  "payload": {
    "playerId": "pl_4f8fc9480f6e569d",
    "resumeToken": "b3d1f0a29c7e45118ab6d2c4e9f01d7a",
    "displayName": "Dana",
    "lobby": {
      "roomCode": "482913",
      "hostPeerId": "crush-482913",
      "hostPlayerId": "pl_7c1e33a90b2d4f68",
      "maxPlayers": 4,
      "phase": "lobby",
      "tableLanguage": "he",
      "players": [
        { "id": "pl_7c1e33a90b2d4f68", "name": "Noa", "isHost": true, "health": "connected", "seat": 0 },
        { "id": "pl_4f8fc9480f6e569d", "name": "Dana", "isHost": false, "health": "connected", "seat": 1 }
      ]
    }
  }
}
```

An action (client → host) — note there is no player id anywhere:

```json
{
  "protocolVersion": 1,
  "id": "5c8a2e1d7b3f9046",
  "roomId": "482913",
  "senderPeerId": "abc123def456",
  "timestamp": 1758000042000,
  "type": "action",
  "payload": { "action": { "type": "playCard", "cardId": "w-colorChange-0", "chosenColor": "green" } }
}
```

Public state (host → all) — card counts only:

```json
{
  "protocolVersion": 1,
  "id": "aa10bb20cc30dd40",
  "roomId": "482913",
  "senderPeerId": "crush-482913",
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

Private hand (host → one client only):

```json
{
  "protocolVersion": 1,
  "id": "bb11cc22dd33ee44",
  "roomId": "482913",
  "senderPeerId": "crush-482913",
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

Events (host → all):

```json
{
  "protocolVersion": 1,
  "id": "cc12dd34ee56ff78",
  "roomId": "482913",
  "senderPeerId": "crush-482913",
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

A rejection (host → one client):

```json
{
  "protocolVersion": 1,
  "id": "dd13ee24ff35aa46",
  "roomId": "482913",
  "senderPeerId": "crush-482913",
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

`mustPlayAfterPlus` is retired: a Plus obligation may now be paid from the draw pile, so no
host emits it any more. It stays in the vocabulary because an older host on a mixed table
still does, and dropping a value from the enum would fail that message's schema — locking
the receiving player's table instead of telling them about a rule they no longer have.

## Version 4: what resilience added

Every field below is **optional**, and that is load-bearing rather than lazy. The site is
static and cached per browser, so the player who reloads — the very thing this work exists to
make survivable — fetches the new bundle while everybody else keeps the old one. If a version
were required to match exactly, that reload would answer `protocolMismatch` to the whole table
and end the game on the way in. A mixed table loses the new behaviour, not the game.

### New fields on existing messages

| Message / object              | Field                                         | Meaning                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicState.state`           | `turnSeq`                                     | Counts turn handovers, not commands. `version` moves for the out-of-turn declarations and catches that are legal at any moment, so it cannot answer "is my move still meant for the table I was looking at?" |
| `publicState.state`           | `endReason`                                   | `won`, or `abandoned` for a round that ran out of players or was stopped by agreement.                                                                                                                       |
| `publicState.state.players[]` | `left`                                        | The seat has left the round. Marked, never removed — which is why this array never falls below the two players the schema requires.                                                                          |
| `lobbyState.lobby`            | `sentAt`                                      | The host's clock when the snapshot was built, so a client can cancel the skew between the two devices once.                                                                                                  |
| `lobbyState.lobby`            | `seatGraceMs`                                 | How long the host will hold an absent seat. On the wire because there must be exactly one authority for it; the client _derives_ its own give-up deadline by subtraction.                                    |
| `lobbyState.lobby`            | `pausedBy`                                    | Who asked the table to wait, or `null`.                                                                                                                                                                      |
| `lobbyState.lobby`            | `waitingFor`, `waitingReason`, `waitingSince` | Who the table is waiting for and why (`turn`, `absent`, `breaker`, `paused`), so no screen has to infer it.                                                                                                  |
| `lobbyState.lobby`            | `abandonVotes`                                | Seats that have agreed to end the round.                                                                                                                                                                     |
| `lobbyState.lobby`            | `generation`                                  | Host generation, so a client can follow a handover.                                                                                                                                                          |
| `lobbyState.lobby.players[]`  | `absentSince`                                 | When the seat went quiet, on the host's clock, paired with `sentAt`. A duration would be stale on arrival and would force a broadcast per heartbeat.                                                         |
| `lobbyState.lobby.players[]`  | `left`                                        | As above.                                                                                                                                                                                                    |
| `action`                      | `requestId`                                   | Identifies one _intent_, stable across re-sends. Not the envelope id, which is regenerated on every send and so cannot match a replay.                                                                       |
| `action`                      | `turnToken`                                   | `{currentPlayerId, turnSeq}` as the client understood them. Checked by the host only for `playCard` in turn, `drawCard` and `closeTaki`.                                                                     |
| `hostClosed`                  | `generation`                                  | Where the room went, for a handover.                                                                                                                                                                         |

### New messages

| Direction     | Type              | Purpose                                                                                                                                                                                            |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| host → client | `actionAccepted`  | `{requestId, version}`. An acknowledgement cannot be inferred from the state moving forward, because other players legally act out of turn here — so a lost action would otherwise look delivered. |
| host → client | `paused`          | Somebody asked the table to hold.                                                                                                                                                                  |
| host → client | `nudged`          | It is your turn and another player is waiting.                                                                                                                                                     |
| host → client | `handoffOffer`    | `{generation, snapshot}`, sent once to the named successor at the moment of a voluntary handover — never continuously.                                                                             |
| client → host | `pauseRequest`    | Ask the table to wait, or let it carry on.                                                                                                                                                         |
| client → host | `abandonVote`     | Agree to end a round with no winner.                                                                                                                                                               |
| client → host | `nudge`           | Nudge the player the table is waiting on.                                                                                                                                                          |
| client → host | `handoffAccepted` | The successor confirms it is serving, which is what lets the old host step down.                                                                                                                   |

### New `hostClosed` reasons

`restarting` and `handoff` are the two that are **not** the end of anything. Before them a
client had no way to tell a goodbye from a see-you-in-a-moment and treated both as fatal,
which made a host returning impossible to build.

| Reason       | Terminal? | Meaning                                                                                                                                                                           |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostLeft`   | yes       | The host closed the room.                                                                                                                                                         |
| `roomReset`  | yes       | The host reset the room.                                                                                                                                                          |
| `restarting` | **no**    | The host is reloading. Hold the seat and keep trying. Sent from `pagehide`, the only hook that fires reliably on a phone.                                                         |
| `handoff`    | **no**    | Another player is taking over at `generation`. Its peer id is _derived_ from the room code and that number, so nothing has to be told an address and the room code never changes. |

### Turn-scoped and out-of-turn intents

`turnToken` is checked for `playCard` in turn, `drawCard` and `closeTaki`. It is deliberately
**not** checked for `declareLastCard`, `catchLastCard`, `passBreak`, or a breaker played into
an open `+3`: those are legal at any moment, they race each other on purpose, and gating them
on a turn would hand every tie to whichever player broke the rule.

## Version compatibility strategy

`protocolVersion` is a single integer, bumped on **any** breaking change to a message shape
or its meaning.

- The version is read in a **loose first pass**, before the strict schema. A peer running a
  different version therefore gets a clear `protocolMismatch` rather than a confusing
  validation error.
- The host replies `joinRejected(protocolMismatch)` and closes; the client shows "the other
  player is running a different version — both sides should reload the page".
- There is no negotiation and no backwards compatibility shim. Both peers load the same
  static site from the same URL, so a mismatch only happens when one has an old tab open. A
  reload fixes it, which is a better outcome than maintaining translation layers between
  versions of a private game.
- Additive, optional fields do **not** need a bump: unknown fields are stripped, and an older
  peer simply ignores them. `wantsSpectator` is an example of a field reserved this way.
- A **rule** change does need one, and it cannot be softened by accepting the older version
  as 4 did with 3. Version 5 — the King cancelling a +2 run — is the first of those: two peers
  on different sides of it would refuse each other's legal moves, so the older one is told to
  reload rather than left to argue.
