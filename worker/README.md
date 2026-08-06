# Super Taki rooms

One Cloudflare Worker, one Durable Object per room code — and the object _is_ the
game. It holds the only complete `GameState`, deals every hand, validates every move
through the pure engine, drives the robots, and owns every deadline. Every player,
including whoever opened the room, is an ordinary client of it.

It used to be a relay: two hundred lines that routed frames between named peers while
the game ran in one player's browser tab. See `../docs/server-game-plan.md` for why
that moved and what it deleted, and `../docs/architecture.md` for what it is now.

```
src/
  index.ts     the fetch handler: /v1/room/<six digits> -> the object of that name
  room.ts      the Durable Object adapter — sockets, SQLite, the platform alarm
  gameRoom.ts  the room's whole brain, with the platform held at arm's length
  alarms.ts    every deadline the room keeps, on the one alarm an object gets
  storage.ts   two validated JSON blobs, and the interface they are reached through
  protocol.ts  what is left of the socket's own concerns: paths, sizes, the TTL
```

The engine, the robots and the wire protocol are **not** here. They are the app's, in
`../src/features/game/`, borrowed by relative import rather than copied — this
project's `tsconfig.json` lists them, so a change to the rules that breaks the room
fails `npm run verify` here as well as the app's own typecheck.

`GameRoom` takes its sockets, its storage, its alarm queue and its clock as arguments.
That is what lets the whole room run in plain Node, and it is why `worker/test/` can
play a full round in a millisecond and assert on every frame that crossed the wire.

```bash
npm run dev      # local room on ws://127.0.0.1:8787
npm run verify   # typecheck + unit tests + the coverage floor under src/
npm run smoke    # a whole round over real sockets against wrangler dev
npm run deploy   # manual deploy (CI does this automatically)
```

Deployed for this repository at `wss://supertaki-relay.ebenzvi.workers.dev` — the name
is historical, and kept deliberately so the `RELAY_URL` repository variable, the
deploy workflow and every built page keep pointing at the same place.
