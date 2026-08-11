# Known Issues

Small, real defects found while working on something else, recorded so they
aren't rediscovered from scratch. Each entry states what breaks, how to
reproduce it, and what a fix would involve. Delete an entry when it's fixed.

---

## Dead auth + database secrets are probably still set on Railway

**What's wrong.** `APP_ACCESS_PASSWORD`, `APP_SESSION_SECRET`, `TCA_DATABASE_URL`
and `V1_DATABASE_URL` were removed from the local `.env` on 2026-08-09, but only
from the local `.env`. The deployment has its own variables, set separately in
the Railway dashboard, and nothing in this repo can see or change them.

Nothing reads any of the four. The login stack that used the first two was
deleted in `6190dac`, and the database the last two pointed at is gone. So they
are not a functional problem — they are live-looking credentials sitting in a
dashboard with nothing behind them, which is exactly the kind of thing that gets
copied into a new service later on the assumption it still means something.

`TCA_DATABASE_URL` and `V1_DATABASE_URL` were the *same* Supabase connection
string, and that instance is deleted, so the credential is inert. The two app
secrets are not inert in the same way: if either password was reused anywhere
else, it is still a live secret.

**How to check.** Railway dashboard → the service → Variables. There is no CLI
check wired up in this repo.

**Fix.** Delete all four from the Railway service. Rotate
`APP_ACCESS_PASSWORD` / `APP_SESSION_SECRET` wherever else they were used, if
anywhere. `TCA_RPC_URL` and `ETHERSCAN_API_KEY` are the only variables the app
still reads, plus the optional `LOG_LEVEL`, `APP_BASE_URL`, the three
`RATE_LIMIT_*` values and the two `*_WEBHOOK_URL`s — see `.env.example`.

---

## The post-deploy smoke check has never been run against production

**What's wrong.** `scripts/smokeDeploy.mjs <live-url>` is the only thing that
verifies the deployed app from outside, and it is entirely manual — there is no
CI wiring and no post-deploy hook. It has not been run since the database
removal merged (`11300f0`), which is the change that moved every route.

The check that matters most is its `/qa` 404 assertion. `/qa/tx/<chain>/<hashes>`
is guarded only by `process.env.NODE_ENV !== 'development'` as the first
statement in the route, and it has no rate limiting at all by design. If that
guard ever evaluates false in production — a deploy exporting `NODE_ENV` to
something unexpected, a Next change to how the value is inlined — it becomes a
public, unmetered `n x 40` RPC endpoint, and nothing else in the system would
notice. The guard is deny-by-default precisely because this is the failure mode,
but deny-by-default is a design choice, not a verification.

**How to reproduce.** Run it. It takes seconds:

```
node scripts/smokeDeploy.mjs https://receipts.withfabric.xyz
```

**Fix.** Run it after every deploy. Wiring it into a post-deploy step would be
better than remembering, and would also cover the receipt-renders and
bad-hash-404 assertions it makes alongside the `/qa` one.

<!--
Fixed and removed:
- `resolveContractName` ignored an explicit `apiKey: undefined` and fell back to
  the environment, making the no-key test env-dependent. Fixed 2026-07-28
  (`'apiKey' in deps`, plus a test pinning each side of the branch).
  Full write-up in the history of this file at d3209f3.
-->
