# Known Issues

Small, real defects found while working on something else, recorded so they
aren't rediscovered from scratch. Each entry states what breaks, how to
reproduce it, and what a fix would involve. Delete an entry when it's fixed.

---

## The post-deploy smoke check is manual, so it drifts between runs

**What's wrong.** `scripts/smokeDeploy.mjs <base-url>` is the only thing that
verifies the deployed app from outside, and it is entirely manual — no CI
wiring, no post-deploy hook. Nothing makes a deploy wait for it, and nothing
notices when it is skipped.

Run against production for the first time on 2026-08-11: **12/12 passed**,
including the assertion that matters most — `/qa` returns 404. That settles what
this entry originally recorded (it had not been run since the database removal
in `11300f0` moved every route) and leaves only the reason it can quietly go
stale again.

`/qa/tx/<chain>/<hashes>` is guarded only by `process.env.NODE_ENV !==
'development'` as the first statement in the route, and it has no rate limiting
at all by design. If that guard ever evaluates false in production — a deploy
exporting `NODE_ENV` to something unexpected, a Next change to how the value is
inlined — it becomes a public, unmetered `n x 130` RPC endpoint, and nothing
else in the system would notice. Deny-by-default is why that has not happened;
but that is a design choice, not a verification, and the verification is the
half that is manual.

**How to reproduce.** Run it. It takes seconds:

```
node scripts/smokeDeploy.mjs https://receipts.withfabric.xyz
```

**Fix.** Wire it into a post-deploy step so it stops depending on someone
remembering. It covers the receipt-renders, security-header and bad-hash-404
assertions alongside the `/qa` one.

One thing to know before putting it on every deploy: the receipt check renders
a real page, so each run spends one fresh analysis (~130 RPC calls) against the
global hourly ceiling and fires `ACTIVITY_WEBHOOK_URL`. Harmless occasionally;
worth a deliberate decision if it becomes automatic.

<!--
Fixed and removed:
- `resolveContractName` ignored an explicit `apiKey: undefined` and fell back to
  the environment, making the no-key test env-dependent. Fixed 2026-07-28
  (`'apiKey' in deps`, plus a test pinning each side of the branch).
  Full write-up in the history of this file at d3209f3.
- Dead auth + database secrets (`APP_ACCESS_PASSWORD`, `APP_SESSION_SECRET`,
  `TCA_DATABASE_URL`, `V1_DATABASE_URL`) were still set on the Railway service
  after the login stack and the database were deleted. All four removed from
  the service 2026-08-11.
  ⚠️ One residual the deletion does NOT cover: if `APP_ACCESS_PASSWORD` or
  `APP_SESSION_SECRET` was ever reused outside this project, the value is still
  live wherever that is — removing it here does not rotate it there.
  Full write-up in the history of this file at 7db0c52.
-->
