# Receipt UI — Figma v3 pass

Date: 2026-07-28
Figma file: `f9uYixaSgpkV1lEvN8Ie01` (TCA)

A render-layer pass over the receipt page: new wordmark, a 40px page rhythm, 34px
list items, all dotted dividers retired, a restyled share bar and footer, a new
`/methodology` route, favicons, and one semantic change (Execution Delta).

## Reference frames

| Frame | Node | Role |
| --- | --- | --- |
| empty | `544-2386` | no-receipt state |
| usd-priced | `546-631` | anchored pair, full geometry |
| token-priced | `549-2673` | unanchored pair (corrected 2026-07-28) |
| unpriced | `549-2857` | null-mid tier |
| logo | `546-636` | RECEIPTS wordmark |
| list item | `546-647` | 34px standalone row |
| fee/leg items | `546-713` | 12px group rows |
| market price | `546-687` | footnote composite |
| share button | `547-1011` | 69px bar |
| footer | `547-1014` | links row |
| methodology | `549-2447` | new page, full copy |

⚠️ Frames carry placeholder numbers. Read them for **geometry, order, and copy
strings only** — never as a pricing oracle. (Prior burns: a Figma row that was a
copy-paste of another row; frames sitting behind the code.)

## 1. Spacing system

`main` is a 720px column with **40px between every block**:

```
logo(40) → 40 → input(40) → 40 → divider → 40 → title → 40 → detail table
         → 40 → divider → 40 → "Cost Breakdown" → 40 → breakdown table
         → 40 → divider → 40 → SHARE(69) → 40 → footer
```

Verified against `546-631` absolute offsets (0, 80, 160, 200, 254, 914, 954,
1008, 1608, 1648, 1757) and reproduced in `549-2673`.

Three dividers, all `--color-primary`, all full-width:

1. **below the input** (y=160) — replaces today's divider under the logo. Present
   in the empty state too, so `544-2386` renders correctly with no receipt.
2. **above Cost Breakdown** (y=914) — new.
3. **above SHARE** (y=1608) — moved up from between SHARE and the footer.

No divider between logo and input. No divider between SHARE and footer.

## 2. Row heights — two regimes

**Standalone rows → `min-h-[34px]`, 20px gap (54px pitch).** Content top-aligned.
A row with a subvalue fills it exactly: 12 + 10 (existing `gap-[10px]`) + 12 = 34.
A row without one carries 22px of trailing slack.

Applies to: every detail-table row, plus `Aggregator Fee`, `Slippage`,
`Positive Slippage`, and `Total Execution Delta` in the breakdown.

`min-height`, not fixed height (user decision): identical to the frames at 720px,
but a wrapped value grows instead of clipping. Wrap risk is real on Execution
Delta, Price Delta, and the FillerRow address.

**Group rows → unchanged at 12px on a 32px pitch.** A group is a heading plus its
children: LP Fee / Pools Touched legs, Price Impact legs, and aggregator fee-sink
lines. `546-713` shows the heading at y=0 and children at 32/64/96/128, all 12px
tall — i.e. exactly today's behavior. The group as a whole is separated from its
siblings by the standard 20px.

Note the heading of a populated group stays 12px; only a *standalone* breakdown
row (`Aggregator Fee` with no sinks, `Slippage`) takes the 34px floor.

## 3. Dotted dividers — removed

Every `<Divider dashed />` inside the receipt goes. Neither table in either frame
contains an internal rule. This retires the `dashed` prop on `Divider` entirely;
the component keeps only its solid primary form.

## 4. Market Price composite

The methodology descriptor currently renders as a `*`-footnote **after** Price
Delta. It moves **up** and binds to the Market Price row:

```
[Market Price row]  ← hugs content: 34px with a USD subvalue, 12px without
  ↕ 10px
[footnote]          ← 36px, two lines at 18px leading
```

Verified: usd `546-687` = 34+10+36 = 80; token `549-3112` = 12+10+36 = 58. The
next row sits 20px below the composite in both.

Three consequences:

- **The `*` disappears** from both the label and the footnote. The label is plain
  `Market Price` in every frame; positional binding replaces the linkage.
- **The footnote renders in all three tiers**, including unpriced — `549-2857`
  shows `Unavailable: No reliable market price could be calculated.` beneath
  `n/a`. The current `hasMarketPrice` gate comes out. Rows with a null
  `methodology` column keep using `fallbackMethodology(pricingStatus)`.
- **The Market Price row alone opts out of the 34px floor**, so the composite can
  hug. Every other detail row keeps it.

## 5. Execution Delta — semantic change

Becomes Price Delta's twin, reusing `priceDeltaSentence` from `priceFormat.ts`:

```
Execution Delta   WBTC bought at $4.57 below Market Price
                                            Per 1 ETH
```

- **Magnitude:** `notionalIn × |allInCostBps| / 10_000` — "dollarized allInBps".
  This welds the row to the `Total Execution Delta` bps row at the bottom; the two
  are one fact in USD and bps and can never disagree.
- **Direction:** gain ⟺ `allInCostBps < 0` (the column is a *cost*; the bottom row
  already renders `-costBps` to get `+25.53bps` green). Combined with
  `baseIsOutput` exactly as `formatPriceDeltaUsd` does, so bought-below and
  sold-above remain the favorable halves.
- **Subvalue:** `Per {formatTokenIn(row)}` → `Per 1 ETH`. Capital `P`, matching
  `546-677`; Price Delta's `per 1 {base}` stays lowercase, matching `546-695`.
- **No color, no Gained/Lost** (user decision). Direction lives in the prose, as
  it already does on Price Delta. Green stays on the bps rows, where the frames
  do show it.
- **Gate:** renders only when the pair is anchored *and* `allInCostBps` is
  non-null — stricter than today's anchored-only gate. Drop the row rather than
  print a bare `$0.00` when the column is null. The token-priced and unpriced
  frames both omit the row, consistent with this.

`formatExecutionResult` becomes unused and is deleted, along with its tests.

`execResultUsd` is **not** touched — an earlier note to retire it was retracted.
It remains load-bearing for `notionalOut` (Token Out's USD subvalue), the Price
Delta magnitude, and the Price Delta direction.

## 6. Chrome

**Logo.** RECEIPTS wordmark replaces the Fabric one. Exported from `546-636` to
`public/receipts-logo.svg`, viewBox tightened from `0 0 720 40` to
`0 0 120.505 40`. Rendered through the **existing CSS-mask technique** (user
decision) so it inherits `--color-primary` and stays legible on the dark, coffee,
and terminal themes; identical to the frame on light. `LOGO_WIDTH` recomputes
from the new 120.505:40 ratio.

**Search.** The `Transaction Hash` label is removed. The placeholder changes from
the full example hash to `Transaction hash`. The divider moves below the input.

**Share bar.** 720×69, full-width, `--color-primary` fill, uppercase `SHARE`
centered (glyphs 165×29 → ~40px Sohne Breit; to be confirmed in-browser). The
copied state becomes `COPIED`.

⚠️ **Out of scope: the History dialog's Share and Delete buttons** (user
instruction). `Receipt` renders in two contexts; `onClose == null` already
distinguishes the standalone page from the dialog and gates the top divider. The
new bar styling is gated on the same predicate, so the dialog keeps today's 40px
buttons untouched.

**Footer.** Loses its `border-t` (the divider is now a separate element above
SHARE). `Built by Fabric.` stays left; four links right-aligned on a 40px gap:

| Label | Href |
| --- | --- |
| Docs | `https://docs.withfabric.xyz/` |
| spanDEX | `https://spandex.sh/` |
| Quotebench | `https://benchmark.withfabric.xyz/` |
| Methodology | `/methodology` |

**Tab title.** `Receipts – Onchain transaction cost analysis` (en dash).

**Favicons.** From `~/Downloads/fabric-favicons` → `public/`: `favicon.ico`,
`favicon-16x16.png`, `favicon-32x32.png`, wired via Next `metadata.icons`. No
180px source provided, so no `apple-touch-icon` tag — better absent than upscaled
from 32px.

## 7. `/methodology`

New route at `app/methodology/page.tsx`, reusing the root layout chrome (logo,
divider, footer). Content transcribed **verbatim** from `549-2447` (user
decision): an `h1` + `v0.1` tag, then `Market Price` with the measured-at-N-1
sentence, then five bold-label paragraphs — `WETH/USDC Price`, the
"up to three methods" line, `Direct-Pool Price`, `WETH-Derived Price`,
`Oracle Reference` — closing on the Verified/Estimated rule.

Static prose in one file; no data access, no new dependency.

## 8. Files

| File | Change |
| --- | --- |
| `public/receipts-logo.svg` | new (Figma export, tightened viewBox) |
| `public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png` | new (copied) |
| `app/layout.tsx` | title/description, `metadata.icons`, drop the `<hr>` |
| `app/methodology/page.tsx` | new |
| `components/header.tsx` | RECEIPTS wordmark + dimensions |
| `components/footer.tsx` | links row, drop `border-t` |
| `components/receiptSearch.tsx` | drop label, new placeholder, divider below |
| `components/receiptView.tsx` | dividers, Market Price composite, Execution Delta, share gating |
| `components/receipt/receiptRows.tsx` | 34px floor, drop `dashed` |
| `components/receipt/priceFormat.ts` | `executionDeltaRow` builder |
| `components/receipt/qualityNotionals.ts` | delete `formatExecutionResult` |
| `components/receipt/receiptDisplay.tsx` | ShareButton large variant |

## 9. Verification

- `receiptView.test.tsx` covers the row set, divider placement, and Execution
  Delta text; `qualityNotionals.test.ts` loses its `formatExecutionResult` block.
- ⚠️ **Substring trap:** `Execution Delta` is a prefix of `Total Execution Delta`.
  Absence assertions must anchor on `'>Label<'`, never bare `not.toContain`.
- ⚠️ **Slice-helper trap:** reordering sections voids
  `html.slice(indexOf(a), indexOf(b))` helpers — an empty slice passes
  vacuously. Moving the methodology footnote above Price Delta will disturb any
  helper spanning that range; re-verify each still returns a non-empty slice.
- ⚠️ Run the suite with **both** a clean env and `.env` exported — the suite's
  color has been shell-dependent before.
- ⚠️ Never `next build` over a live dev server; use `npx tsc --build` for core.
- Browser-verify all four states at 720px plus a narrow viewport (the wrap case
  the `min-height` decision exists for), across light/dark/terminal themes.

## Out of scope

- History dialog Share/Delete buttons.
- Retiring `execResultUsd`.
- Any pricing or persistence change. This is render-layer only; no migration, no
  repopulation.
