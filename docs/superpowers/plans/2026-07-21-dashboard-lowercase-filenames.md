# Dashboard Lowercase-First Filenames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the PascalCase dashboard component files to camelCase-first-lowercase (matching `core/src`), delete the dead `ChevronDown.tsx`, and repoint all import specifiers — no behavior change.

**Architecture:** One atomic change. The working filesystem is case-insensitive, so every rename is a two-step `git mv` via a temp name; a naive one-step rename silently no-ops. File names and import specifiers change; exported identifiers (React components, TS types) stay PascalCase.

**Tech Stack:** TypeScript, React (Next.js), vitest. Built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **File names only, no behavior change.** Exported component and type identifiers stay PascalCase (JSX requires component tags to be PascalCase; TS types are PascalCase by convention). Only filenames and the import specifiers referencing them change.
- **Case-insensitive filesystem.** Every rename is two-step via a temp name: `git mv X.tsx X.tsx.tmp && git mv X.tsx.tmp x.tsx`. Never a one-step case-only `git mv`.
- **Baseline: 427 tests pass across 32 files.** Must stay 427 green.
- **Atomic:** one commit for the whole rename + repoint. A partial rename leaves broken imports.
- Gates before committing: `npx tsc --build` (clean), `npm run lint` (clean), `npx vitest run` (427 pass), and a dev-render check (`/?tx=…` → 200 — a mis-cased import breaks at module resolution, which the dev bundler surfaces).
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Rename files, delete dead code, repoint imports

**Files:**
- Delete: `packages/dashboard/components/ChevronDown.tsx`
- Rename (two-step each): `FailureNotice.tsx`, `Footer.tsx`, `Header.tsx`, `NavTabs.tsx`, `ReceiptSearch.tsx`, `ReceiptView.tsx`, `TradesTable.tsx`, and the tests `FailureNotice.test.tsx`, `ReceiptView.test.tsx`, `TradesTable.test.tsx` → lowercase-first
- Modify (import specifiers): `app/layout.tsx`, `app/page.tsx`, `app/trades/page.tsx`, and the renamed `header.tsx`, `receiptSearch.tsx`, `receiptView.tsx`, `tradesTable.tsx`, plus the three renamed test files

- [ ] **Step 1: Delete the dead ChevronDown component**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
git rm packages/dashboard/components/ChevronDown.tsx
```
(Verified upstream: zero references anywhere in the dashboard.)

- [ ] **Step 2: Rename all 10 files, two-step via temp (case-insensitive FS)**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder/packages/dashboard/components
for pair in \
  "FailureNotice.tsx:failureNotice.tsx" \
  "Footer.tsx:footer.tsx" \
  "Header.tsx:header.tsx" \
  "NavTabs.tsx:navTabs.tsx" \
  "ReceiptSearch.tsx:receiptSearch.tsx" \
  "ReceiptView.tsx:receiptView.tsx" \
  "TradesTable.tsx:tradesTable.tsx" \
  "FailureNotice.test.tsx:failureNotice.test.tsx" \
  "ReceiptView.test.tsx:receiptView.test.tsx" \
  "TradesTable.test.tsx:tradesTable.test.tsx" ; do
  src="${pair%%:*}"; dst="${pair##*:}"
  git mv "$src" "$src.tmp" && git mv "$src.tmp" "$dst"
done
```

- [ ] **Step 3: Verify no PascalCase component files remain**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
ls packages/dashboard/components/[A-Z]*.tsx 2>/dev/null && echo "STILL PASCALCASE — investigate" || echo "clean: no PascalCase component files"
```
Expected: `clean: no PascalCase component files`. If any remain, the two-step rename did not take — do NOT proceed; re-run the temp-swap for that file.

- [ ] **Step 4: Repoint the 8 static import specifiers**

Edit each line (filename segment lowercased; identifiers unchanged):

- `packages/dashboard/app/layout.tsx`:
  - `import { Header } from '../components/Header';` → `'../components/header';`
  - `import { Footer } from '../components/Footer';` → `'../components/footer';`
- `packages/dashboard/app/page.tsx`:
  - `import { ReceiptView } from '../components/ReceiptView';` → `'../components/receiptView';`
- `packages/dashboard/app/trades/page.tsx`:
  - `import { TradesTable } from '../../components/TradesTable';` → `'../../components/tradesTable';`
- `packages/dashboard/components/header.tsx`:
  - `import { NavTabs } from './NavTabs';` → `'./navTabs';`
- `packages/dashboard/components/receiptSearch.tsx`:
  - `import { FailureNotice } from './FailureNotice';` → `'./failureNotice';`
- `packages/dashboard/components/receiptView.tsx`:
  - `import { ReceiptSearch } from './ReceiptSearch';` → `'./receiptSearch';`
- `packages/dashboard/components/tradesTable.tsx`:
  - `import { Receipt } from './ReceiptView';` → `'./receiptView';`

- [ ] **Step 5: Repoint the ~106 test dynamic-import specifiers**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder/packages/dashboard/components
perl -pi -e "s{await import\('\./ReceiptView'\)}{await import('./receiptView')}g" receiptView.test.tsx
perl -pi -e "s{await import\('\./TradesTable'\)}{await import('./tradesTable')}g" tradesTable.test.tsx
perl -pi -e "s{await import\('\./FailureNotice'\)}{await import('./failureNotice')}g" failureNotice.test.tsx
```

Verify each old specifier is fully gone and the new one is present:
```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder/packages/dashboard/components
grep -c "import('./ReceiptView')" receiptView.test.tsx    # expect 0
grep -c "import('./receiptView')" receiptView.test.tsx    # expect 49
grep -c "import('./TradesTable')" tradesTable.test.tsx    # expect 0
grep -c "import('./tradesTable')" tradesTable.test.tsx    # expect 54
grep -c "import('./FailureNotice')" failureNotice.test.tsx # expect 0
grep -c "import('./failureNotice')" failureNotice.test.tsx # expect 3
```

- [ ] **Step 6: Sweep for any missed reference to a renamed file**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
grep -rnE "(from|import\() '[^']*/(ReceiptView|TradesTable|ReceiptSearch|FailureNotice|NavTabs|Header|Footer|ChevronDown)'" packages/dashboard --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "\.next"
```
Expected: no output. Any hit is a specifier that still points at an old PascalCase filename — fix it (lowercase the filename segment) before proceeding. (This catches strays the enumerated lists missed.)

- [ ] **Step 7: Gate — tsc**

```bash
npx tsc --build
```
Expected: exits 0, no output. A `Cannot find module './ReceiptView'` here means a specifier was missed — fix and re-run. (On a case-insensitive FS tsc may still resolve a mis-cased path; Steps 5–6 and the lint/dev gates are the real guards, so do not rely on tsc alone to catch casing.)

- [ ] **Step 8: Gate — lint**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 9: Gate — full suite**

```bash
npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: `Test Files 32 passed (32)` / `Tests 427 passed (427)`.

- [ ] **Step 10: Gate — dev render (catches module-resolution/casing breakage)**

With the dev server on `:3000`:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/?tx=0xeeb5a12f8b737f87e80b978da362b625efec4afaf55cbeaf24affcbbb8f69caf"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/trades"
```
Expected: `200` for both. If the dev server is not running, note it and rely on the suite; do NOT run `next build`.

- [ ] **Step 11: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
git add -A
git commit -m "$(cat <<'EOF'
refactor(dashboard): lowercase-first component filenames

Rename the PascalCase component files (FailureNotice, Footer, Header, NavTabs,
ReceiptSearch, ReceiptView, TradesTable) and their tests to camelCase-first-
lowercase, matching core/src. Delete the dead ChevronDown.tsx (zero references).
Repoint the 8 static and ~106 test dynamic import specifiers. File names only —
exported component/type identifiers stay PascalCase. Renames done two-step via a
temp name because the filesystem is case-insensitive.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

Confirm git recorded the renames (not delete+add) so history is preserved:
```bash
git show --stat HEAD | grep -E "=>|rename" | head
```
Expected: `rename` lines (or `{Old => new}` notation) for the 10 files, plus a delete for `ChevronDown.tsx`.

---

### Task 2: Update the refactor backlog memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/refactor-backlog.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the rename pass as done**

In `refactor-backlog.md`, remove the "lowercase-first dashboard file-rename pass" from the open list and add a DONE entry (files renamed, ChevronDown deleted, commit hash). Note that only the `Direction` v1-vestige rename remains open. Update the MEMORY.md index line accordingly. (Memory files are outside the repo — no commit.)

---

## Notes for the executor

- **The case-insensitive rename is the whole risk.** If Step 3 shows a PascalCase file still present, the one-step rename silently failed — the two-step temp swap in Step 2 is mandatory. Never `git mv ReceiptView.tsx receiptView.tsx` directly.
- **This is one atomic commit.** Do not commit between the rename and the repoint — the tree is uncompilable in between. All of Steps 1–10 precede the single commit in Step 11.
- **No identifier renames.** If you find yourself changing `ReceiptView` (the export) rather than `ReceiptView.tsx` (the file) or a `'./ReceiptView'` specifier, stop — that would break JSX.
