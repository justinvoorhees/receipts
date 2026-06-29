# Table Header Tooltips — Design Spec

**Date:** 2026-06-26  
**Branch:** feat/cost-model-v2  
**Files affected:** `packages/dashboard/components/TradesTable.tsx`

---

## Overview

Add hover + keyboard-focus tooltips to selected column headers in the Transactions dashboard table. Three columns have tooltips now; more will be added later. Implementation is CSS-only (Tailwind `group`/`group-hover`/`group-focus-visible`) — no JS state, no new dependencies.

---

## Columns with Tooltips

| Column | Tooltip text |
|---|---|
| Accuracy | "The delta between realized execution price and market mid; sum of L.P Fee, Agg Fee, Impact, and Slippage" |
| Impact | "Per-venue execution difference measured against that venue's prior-block mid, excluding L.P. fee." |
| Slippage | "Residual execution difference after L.P. fees, aggregator fees, or measured price impact." |

Block, Aggregator, Size, L.P. Fee, and Agg. Fee have no tooltip.

---

## Component Changes

### `SortHeader`

Add an optional `tooltip?: string` prop.

When `tooltip` is provided:
- Add `group relative` to the button's className
- Render a tooltip `div` inside the button, before the label span

### Tooltip `div` structure

```html
<div
  role="tooltip"
  id="tooltip-{col}"
  class="
    absolute bottom-full mb-[8px]
    left-1/2 -translate-x-1/2
    z-10
    invisible group-hover:visible group-focus-visible:visible
    bg-[var(--color-primary)]
    text-[var(--color-surface-base)]
    rounded-[2px] p-[10px]
    max-w-[320px] w-max
    font-['Sohne_Mono'] text-[12px] leading-[20px]
    font-normal not-italic normal-case
    whitespace-normal text-left
    pointer-events-none
  "
>
  {tooltip}
</div>
```

Button gets `aria-describedby="tooltip-{col}"` when `tooltip` is set.

### Key style decisions

- `bottom-full mb-[8px]` — positions above the header with an 8px gap
- `left-1/2 -translate-x-1/2` — centers on the trigger (matches Figma centering)
- `w-max` with `max-w-[320px]` — shrinks to content width for short text, caps at 320px for long text (handles small content gracefully)
- `whitespace-normal text-left normal-case` — overrides the button's `uppercase` and `whitespace-nowrap` styles
- `pointer-events-none` — prevents the tooltip from intercepting mouse events
- `font-normal not-italic` — resets any inherited weight/style from the button

### Accessibility

- `role="tooltip"` on the tooltip div
- `aria-describedby="tooltip-{col}"` on the button
- Tooltip visible on both hover (`group-hover`) and keyboard focus (`group-focus-visible`)

---

## Out of Scope

- No tooltip arrow/caret (the Figma cursor icon is a design-time illustration of the hover interaction, not a real UI element)
- No animation/transition (not in the Figma spec)
- No portal/z-index management beyond `z-10` (tooltip is contained within the header row, no overflow:hidden ancestors)
