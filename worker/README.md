# Super Taki room relay

One Cloudflare Worker, one Durable Object per room code. Routes JSON frames
between named peers, arbitrates peer-id ownership with client-minted claims,
stores nothing else. See `../docs/architecture.md` and `../docs/deployment.md`.

```bash
npm run dev      # local relay on ws://127.0.0.1:8787
npm run verify   # typecheck + unit tests
npm run smoke    # real WebSocket clients against wrangler dev
npm run deploy   # manual deploy (CI does this automatically)
```
