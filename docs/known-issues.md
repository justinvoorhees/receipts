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

---

## Any link expander can spend an analysis, and robots.txt does not stop it

**What's wrong.** `GET /tx/<chain>/<hash>` runs a full ~130-call analysis on
every hit, and `public/robots.txt` was the assumed defence against automated
fetches. It is not one. Measured 2026-08-11: Slack fetched a receipt URL to
build a message preview despite `Disallow: /tx/` being served correctly, which
rendered the receipt and spent the analysis.

Slack is now handled — `unfurl_links`/`unfurl_media` in `lib/alerts.ts` stop it
at the source, and that closed a feedback loop where each activity message
caused a second render. But that fix only covers **messages we post**. Nothing
covers a receipt link pasted into Slack by a person, or into iMessage, Discord,
WhatsApp, Teams, or any other client that previews links. Each such paste is a
full analysis charged to the global hourly ceiling, and receipts are meant to
be shared — so this is on the happy path, not an edge case.

**How to reproduce.** Paste a receipt URL into any chat client that previews
links and watch `ACTIVITY_WEBHOOK_URL` — a message appears for a receipt nobody
opened.

**Partly fixed 2026-08-11.** `middleware.ts` now recognises known expander
user-agents and serves a cheap `<head>`-only stub above the route, so those
fetches never reach `loadReceipt`. Verified against a dev server: the same URL
returns 983 bytes in 0.34s to a Slackbot UA and 161KB in 12.1s to a Chrome UA.
`scripts/smokeDeploy.mjs` asserts both directions on every run.

**What is still open.** The matcher is a user-agent list, which means:

- It drifts. Every token in `lib/linkExpander.ts` is a snapshot of what those
  services sent on 2026-08-11, and nothing tells us when one changes.
- It is incomplete by construction. An expander not on the list — a new app, a
  self-hosted bot, anything sending a browser-ish UA — still pays full price.
- It cannot be tightened much. The list deliberately errs toward missing a bot
  rather than risking a match on a real browser, because a false positive
  serves a person a stub where their receipt should be.

So this narrows the hole rather than closing it, and it is explicitly a cost
optimisation and not a security control: a UA is self-reported, and the only
thing forging one buys is a cheaper response.

**The durable fix** is caching `loadReceipt`, which makes a second fetch of the
same hash free regardless of who makes it — covering the expanders we do not
recognise, and the thundering-herd case where a link reaches fifty people at
once. See the Deferred section of
`docs/superpowers/specs/2026-08-06-database-removal-design.md`.

⚠️ Do not reach for that without first resolving the concurrent-decode
inconsistency (same transaction, different receipts, no flag). Caching would pin
whichever answer landed first for the whole TTL, turning an intermittent wrong
receipt into a sticky one.

Note the per-IP limiter does not help here: expanders fetch from their own
infrastructure, so each arrives with a full budget.

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
