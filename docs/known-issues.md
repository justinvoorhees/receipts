# Known Issues

Small, real defects found while working on something else, recorded so they
aren't rediscovered from scratch. Each entry states what breaks, how to
reproduce it, and what a fix would involve. Delete an entry when it's fixed.

---

_No open entries._

<!--
Fixed and removed:
- `resolveContractName` ignored an explicit `apiKey: undefined` and fell back to
  the environment, making the no-key test env-dependent. Fixed 2026-07-28
  (`'apiKey' in deps`, plus a test pinning each side of the branch).
  Full write-up in the history of this file at d3209f3.
-->
