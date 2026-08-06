# Threat model

## What this is, and what it is not

Super Taki is a **private game between people who know each other**, running as a static site
against one small server the repository owner deploys. That context sets the security bar
honestly:

- It **is** a goal that a buggy or hostile _client_ cannot corrupt the game, read another
  player's hand, or crash the room.
- It **is** now also true that no _player_ can cheat by inspecting the authority. This used to
  be the opposite: the game ran in the room creator's tab, so a determined host with developer
  tools could deal itself a good hand, and this document said so. Moving the game to the
  server removed that, and it is the one security property this change actually improved.
- What it costs is stated in §11: every hand now exists on the operator's infrastructure for
  the life of the room. The operator is the repository owner.
- It **is not** an authentication system. A room code is an invitation, not a password.

Everything below follows from that.

## Assets

| Asset             | Why it matters                                      |
| ----------------- | --------------------------------------------------- |
| A player's hand   | The only genuinely private game data.               |
| Game integrity    | The rules must hold, or the game is pointless.      |
| Display names     | Shown to everyone in the room; a spoofing surface.  |
| Rejoin token      | Grants a seat back after a refresh.                 |
| Room storage      | Holds every hand and the deck, for the room's life. |
| Local preferences | Low value; still not worth leaking.                 |

There is no password, no email address, no payment data and no persistent account anywhere in
the system, so none of those can be lost.

## Trust boundaries

```
  Player's browser (trusted by that player only)
   • holds its own hand and the public table, and nothing else
        │
        │  wss:// (TLS), one socket per player, game messages end to end
        ▼
  The room — worker/ on the operator's Cloudflare account
   • authoritative: holds every hand, the deck and the RNG state
   • persists them in the object's SQLite for the life of the room
   • runs code from this repository
```

Two boundaries, not three. The previous design had a relay in the middle that could read
frames but held no state, and behind it a _player's browser_ that held everything. The
player-shaped trust boundary is gone: no device now holds anything but its own cards.

## Threats and mitigations

### 1. A malicious or buggy client tries to forge state

**Mitigation — structural.** There is no message in the protocol that carries game state from
a client. The client vocabulary is `joinRequest`, `resumeRequest`, `action`, `leave`,
`playAgainVote`, `pauseRequest`, `abandonVote`, `nudge`, `roomCommand`. `action` can only say
_what the player wants to do_. A client cannot assert "the state is now X" because the wire
format has no way to express it, and the room has no code path that would accept it.

Tested: a scripted client sends room-only message types and they are rejected as `unknownType`.

### 2. A client sends invalid or nonsensical commands

**Mitigation.** Every command goes through the pure engine, which validates against the
current state and returns a structured rejection instead of mutating anything:
not your turn, card not in hand, illegal card, colour required, must play after Plus, cannot
draw during Taki, wrong Taki colour, and so on. The rejection is sent back only to the player
who asked, and the state is untouched.

Tested: a client asks to play a card that is in _another player's_ hand — rejected with
`cardNotInHand`; a client acts out of turn — rejected with `notYourTurn`.

### 3. A client impersonates another player

**Mitigation.** Client messages do not carry a player id. The room binds a seat id to the
WebSocket at join time and injects that id into every command it builds. To act as another
player you would have to take over their socket, not edit a field.

`resumeRequest` is the one exception, and it must present the seat's random 16-byte token.

Tested: the serialised `action` payload is asserted not to contain any player id; a resume with
a wrong token is rejected.

### 4. Message spoofing over the transport — the honest limits

`senderPeerId` in the envelope is **not** an authentication field, and nothing is routed by it.
It is a connection label kept for logs. Anything received on a socket is treated as coming from
the seat that socket is bound to, which is the whole of the guarantee:

- There is nothing between a player and the room. Each client holds one `wss://` socket
  straight to the object; no frame a player sends is ever forwarded to another player
  verbatim, because the room answers rather than relays. What every other player sees is
  the room's own recomputed public state.
- The socket is TLS-encrypted, so a third party on the network cannot inject frames or read
  them.
- The binding is the object's, not the message's: the seat id is stored on the socket's
  attachment when the join or resume is accepted, and every command is built by the room from
  that. Speaking as another player therefore requires holding their socket or their 16-byte
  resume token.
- One seat, one live socket: a second connection accepted for a seat closes the first with
  `superseded`, so a seat cannot be driven from two places at once.
- The room itself could read anything, and does — it holds every hand. That is §11, and it is
  the trust this design spends. It is code from this repository, running on the repository
  owner's own Cloudflare account.

### 5. Replay and duplicate messages

**Mitigation.** Each connection keeps a bounded LRU of the last 512 envelope ids and drops
repeats. That covers accidents on the wire, and nothing else: an envelope id is minted fresh on
every send, so a deliberate re-send of the same intent carries a new one. What makes an intent
idempotent is `requestId`, which lives on the _seat_ rather than the connection and therefore
survives a reconnect: a repeated request id is answered with the same acceptance and applied
once. Snapshots carry a monotonic version, and a client ignores anything older than what it has
applied, so a replayed snapshot cannot roll a client back.

Tested: a replayed `requestId` is answered once and moves the state once; a repeated
`joinRequest` on one socket is answered rather than ignored, and seats one player.

### 6. Denial of service by a player

A player who is already in the room can be a nuisance, and in a private game with no accounts
there is no way to prevent that entirely. What is bounded:

- Frames are refused by the socket above 128 Ki _UTF-16 code units_ — up to three bytes each,
  so the true byte ceiling is higher than the name suggests. It is a memory bound rather than a
  budget, and it is checked on the raw string precisely so a megabyte of garbage is never
  parsed. The decoded message is then held to 64 Ki units by the protocol.
- Every string, array and number in every schema has a maximum, so a hostile payload cannot
  allocate unbounded memory.
- A second accepted connection for a seat closes the first, so nobody can accumulate sockets.
- Invalid messages change no state, and cost a parse and a log line. The log line is a
  deliberate choice over silence — a room refusing frames is worth being able to see — and it
  is one line per frame with no payload in it.
- The seat holding the lobby buttons can remove any player before the game starts; leaving is
  just leaving, and the room stays open for everybody else.

- A socket that opens and never sends a `joinRequest` is closed on the room's next wake,
  once past the join timeout. It is not free to leave one open: the room never learns a
  silent socket exists, so no deadline it keeps would ever have noticed.

**Not mitigated, honestly:** there is no rate limiter anywhere. A player in the room can flood
valid-but-useless messages and consume the object's CPU, and anything can open sockets to a
room code faster than the reaper closes them. Two things bound it. The blast radius is one
room — Durable Objects are isolated per room code, so a flooder spoils the table they are at
and no other. And a room code has to be found before it can be attacked, which is §9.

What is _not_ bounded is a script walking the six-digit space: each distinct code instantiates
an object and bills a request. Nothing in this design prevents that, and no free-plan
deployment of anything prevents it; it is stated here rather than left for somebody to
discover. In a private game among friends, the proportionate response to a player being a
nuisance is to kick them, and to a room being found is to make a new one.

Equally, joining a room requires only the room code, so anyone with the invite link can occupy
a seat until the game starts. Treat the link like an invitation to your living room.

### 7. Reading another player's hand

**Mitigation — layered.**

1. `toPublicGameState()` is the only producer of the broadcast payload, and it maps players to
   `{id, name, cardCount}`. There is no field that could hold a card.
2. `publicGameStateSchema` cannot validate a hand even if one were somehow attached — the
   extra field would be stripped.
3. Private hands are unicast with `connection.send`, never broadcast.
4. A client checks that a received hand belongs to it and ignores anything else, so even a
   buggy room cannot make a client render another hand.

Tested three ways: a unit test asserts no hand card id appears in a serialised public
snapshot; a room test plays a round and asserts that no frame ever sent to one player carries
a card id from another player's hand or from the draw pile; a Playwright test asserts the same
in real rendered HTML, against the real room.

**Remaining exposure:** the room legitimately holds every hand, because someone has to. No
_player_ can look, which is the change: the holder used to be one of the players. What holds
it now is the operator's infrastructure — see §11.

### 8. Cross-site scripting

**Mitigation.**

- `dangerouslySetInnerHTML` is not used anywhere in the codebase. All player-supplied text
  goes through React text nodes, which escape by construction.
- Display names are sanitised in the room, on arrival: normalised to NFC, stripped of C0/C1 controls, bidi
  overrides and embeddings, zero-width marks and the BOM, whitespace-collapsed, and truncated
  to 16 characters. This is about readability and anti-spoofing (a bidi override can make one
  name render as another), not about HTML escaping, which React already handles.
- A Content Security Policy is set in `index.html`: `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `form-action 'none'`, no `unsafe-inline` for scripts, and
  `connect-src` limited to exactly two destinations — the page's own origin and the room
  worker it was built for (injected from `VITE_RELAY_URL` at build time). `style-src` allows
  `unsafe-inline` because the app sets `color-scheme` on the root element and Vite injects a
  style tag in development — a documented, narrow exception.
- No external images, no remote fonts, no CDN scripts, no analytics. Nothing to compromise.

### 9. Invite-link privacy — the honest limits

- A room code identifies a room; it does **not** authenticate a person. Anyone holding the
  link can attempt to join while the room is open.
- The code space is six digits — 1,000,000 combinations. That is fine against accidental
  collision and casual guessing for a room that lives for an hour, and it is **not**
  cryptographic. A determined attacker could enumerate it. For a private game among friends
  that is an accepted trade-off; the mitigations that matter are that rooms are short-lived,
  capped at six seats, and closed to new players once the game starts.
- The length is a deliberate floor. Every string of digits is a valid code, so a four-digit
  code turns a single mistyped digit into somebody else's live room rather than an error, and
  ten thousand rooms can be walked through by hand in an evening. Six digits keeps the code
  dictatable and the space a hundred times larger.
- Invite links are shared through whatever channel the players choose (a message app, say).
  That channel's privacy is outside this app's control.
- The app removes invite parameters from the address bar after reading them, so a room code is
  not left in the browser history of a shared device.
- Never put anything secret in a URL, and this app does not: the link carries a room code.
  Nothing else. It used to carry a peer id as well, so that a joiner could address the host's
  device; there is nothing to address now, because the room is at the room code.

### 10. Local-storage limitations

What is stored: language, theme, sound, display name, and — while a room is live — the room
code, the seat id, the rejoin token, the display name that seat was taken under, and a
timestamp.

- `localStorage` is **not** encrypted and is readable by any script on the same origin. Since
  the origin serves only this app and loads no third-party scripts, the practical exposure is
  another person using the same browser profile.
- The rejoin token expires after 6 hours, and stored values are validated on read (shape, room
  code format, seat id format, token length, timestamp sanity); anything suspect is deleted
  rather than used.
- Leaving a room, being removed, or a room closing all erase the entry immediately. The home
  screen offers "Start fresh" to erase it manually.
- On a shared or public device, the rejoin token is the one thing worth caring about, and the
  worst it grants is one seat in one room that has probably already ended.

### 11. Hands on the server — the honest limits

Every hand, the draw pile order and the RNG state live in the room's Durable Object storage,
for as long as the room exists. This is new, it is the cost of the change that removed host
cheating, and it deserves stating plainly rather than in a footnote.

**Who can read them.** Whoever holds the Cloudflare account: `wrangler tail` shows the
worker's logs, and account access reaches the object's storage. That is the repository owner —
the same person who deploys the site the players load. No player can, and no third party can:
the transport is TLS and the object is not addressable from outside the worker.

**How long.** Until six hours after the last player leaves, when the TTL alarm fires and calls
`storage.deleteAll()`. A finished round is not special — the room holds its state until the
TTL, because players commonly deal again.

**What was considered and rejected.** Encrypting hands under a key the server does not hold is
incompatible with the server being the rules authority: it has to know what is in a hand to
decide whether a card may be played. Any scheme that keeps that from it moves the authority
back into a browser, which is the arrangement this replaced.

**Why this is acceptable here.** The game has no stakes, the operator is the person whose
repository the players are already trusting to serve them JavaScript, and the alternative
placed the same data on a _player's_ device, where the incentive to look actually exists.

### 12. The room disappearing

If Cloudflare's edge or the free plan has a bad day, no game runs. The client reports the
outage honestly and retries with jittered, capped backoff; seats and credentials survive, so a
room that comes back is the room the players left. This is a single point of failure and is
listed as one in [architecture.md](architecture.md).

## Summary

| Threat                                | Status                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Client forges game state              | Prevented structurally (no such message)                                   |
| Client sends illegal moves            | Prevented (server-side engine validation)                                  |
| Client impersonates a player          | Prevented (socket-bound seat ids)                                          |
| Client reads another hand             | Prevented (public view carries counts only, hands unicast)                 |
| Replay / stale messages               | Prevented (message-id LRU + monotonic versions)                            |
| Oversized / malformed messages        | Prevented (64 KiB cap, bounded Zod schemas)                                |
| XSS                                   | Prevented (no raw HTML, sanitised names, CSP)                              |
| Duplicate connections                 | Handled (older channel closed)                                             |
| Room-code guessing                    | Partially mitigated (10^6 codes, short-lived, 6 seats, closed after start) |
| Flooding by a joined player           | **Not mitigated** — kick; blast radius is the one room                     |
| A player cheating by inspecting state | **Prevented** — no player's device holds another's cards                   |
| Room outage                           | **Not mitigated** — single point of failure, reported honestly in the UI   |
| Operator reading hands                | **Accepted and stated** — see §11; bounded by a 6-hour deletion            |
| Room-code guessing at creation        | Bounded — a code already in use is refused, and the client draws another   |

## What is written down, and where

Two records, and it is worth being precise about which is where.

**On the server**, for the life of the room: the seats, their credentials, and the game —
every hand, the deck order, the RNG state. Deleted six hours after the last player leaves.
See §11.

**On each player's device**: one credential — `{roomCode, playerId, resumeToken, displayName,
savedAt}` — and the local diagnostics ring. That is all. The record that used to sit here was
very different: the room creator's device held **the entire game, including every player's
hand**, in `localStorage`, because a reload would otherwise have destroyed the only copy. That
is gone with the thing that required it.

- The credential grants one seat in one room, expires after six hours, and is validated on
  every read.
- It is erased on an intentional leave, on being removed, and by "start fresh" in settings.
- Nothing is transmitted. Neither the credential nor the diagnostics log leaves the device
  except as part of joining the room it names.
