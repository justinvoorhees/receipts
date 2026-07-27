# Known Issues

Small, real defects found while working on something else, recorded so they
aren't rediscovered from scratch. Each entry states what breaks, how to
reproduce it, and what a fix would involve. Delete an entry when it's fixed.

---

## `resolveContractName` ignores an explicit `apiKey: undefined` and falls back to the environment

**Found:** 2026-07-27, during per-leg router attribution work (it made the full
suite red in any shell with `.env` exported).
**Files:** `packages/core/src/contractNames.ts:72`, `packages/core/src/contractNames.test.ts:33-39`

### What's wrong

`resolveContractName` resolves its API key with:

```ts
const apiKey = deps.apiKey ?? process.env.ETHERSCAN_API_KEY;
```

`??` cannot distinguish *"the caller explicitly passed `undefined`"* from
*"the caller passed nothing"*. Both are `undefined`, so both fall through to
the environment.

That defeats the dependency-injection seam. `NameResolverDeps` exists so the
function can be exercised in isolation — `fetchImpl`, `cache` and `apiKey` are
all injectable — but `apiKey` alone silently reaches outside the injected
world.

### Why it matters

The fail-closed test cannot test the thing it names:

```ts
it('returns null (no throw) when no api key', async () => {
	const fetchImpl = vi.fn() as unknown as typeof fetch;
	const name = await resolveContractName('0x1', { fetchImpl, apiKey: undefined, cache: {} });
	expect(name).toBeNull();
	expect(fetchImpl).not.toHaveBeenCalled();
});
```

Its behaviour depends on the ambient environment:

- **No `ETHERSCAN_API_KEY` in the environment** — the test passes, but only by
  accident. It is exercising the env-fallback path returning `null`, not the
  "caller supplied no key" path it claims to cover. Vacuous green.
- **`ETHERSCAN_API_KEY` exported** (e.g. `set -a && source .env && set +a`,
  which is required to run the RPC e2e tests) — the real key is picked up, the
  guard at line 74 is never reached, a live fetch is attempted, and the test
  **fails**:

  ```
  AssertionError: expected "spy" to not be called at all, but actually been called 1 times
    1st spy call: [ "https://api.etherscan.io/v2/api?…&apikey=XKSJY…" ]
  ```

So the suite's colour depends on how the shell was set up, and the one test
guarding the no-key path never runs that path in either case. It is the only
failure in an otherwise green suite when `.env` is exported.

### Reproducing

```bash
# Red
set -a && source .env && set +a && npx vitest run contractNames

# Green (for the wrong reason)
env -u ETHERSCAN_API_KEY npx vitest run contractNames
```

### Fix sketch

Distinguish "absent" from "explicitly undefined". Either:

1. **Read the env only when the key is truly absent** — check
   `'apiKey' in deps` rather than using `??`:

   ```ts
   const apiKey = 'apiKey' in deps ? deps.apiKey : process.env.ETHERSCAN_API_KEY;
   ```

   Smallest change; the existing test then exercises the branch it names.

2. **Drop the env fallback entirely** and make the caller pass the key. Purer —
   the function stops depending on ambient state — but it moves the
   `process.env` read to every call site (`app/api/receipts/route.ts` and
   `scripts/repopulateReceipts.mjs`), so it's a wider change.

Either way, add a second test that pins the *other* branch: with no `apiKey`
in `deps` and `ETHERSCAN_API_KEY` set, the fetch *should* happen. Today
nothing covers that direction, which is why the ambiguity went unnoticed.

### Scope note

This is not a production correctness bug — every real caller passes a key or
genuinely wants the env fallback, and the function still fails closed
(returns `null`, never throws) when there is no key anywhere. The damage is to
test integrity and to the suite being trustworthy as a merge gate.
