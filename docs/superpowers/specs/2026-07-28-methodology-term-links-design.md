# Methodology term links in the Market Price footnote

## Problem

The Market Price row's methodology footnote (`receiptView.tsx`) renders a plain-text
sentence built by `packages/core/src/pricing.ts` (`methodologyFor`), e.g.:

> Estimated: The direct-pool price and WETH-derived price disagree, and the oracle
> reference does not confirm their median. Showing the median of the two liquidity-based
> prices.

Figma frame `546-694` styles three specific phrases within these sentences —
`direct-pool price`, `WETH-derived price`, `oracle reference` — as dotted-underline
links. Confirmed via `get_design_context` on that node: all three spans carry
`underline decoration-dotted`. The dashboard has no interactive version of this text
yet; the phrases render as inert copy.

## Design

Add a presentational component, `MethodologyText({ text }: { text: string })`, to
`packages/dashboard/components/receipt/receiptRows.tsx` alongside the other row
helpers (`DetailRow`, `Divider`, etc.). It splits `text` on a fixed alternation of the
three known phrases and wraps each match in:

```tsx
<a
  href="/methodology"
  target="_blank"
  rel="noreferrer"
  className="underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
>
  {phrase}
</a>
```

This reuses the exact dotted/hover-solid class combination already used throughout
the receipt (`receiptRows.tsx` DetailRow tooltips, `footer.tsx` nav links) — no new
visual language. `target="_blank"` is a deliberate deviation from the footer's
same-tab `/methodology` link: the user asked for these inline references to open in a
new tab so the trade receipt stays open underneath.

The three phrases are treated as a **static, exhaustive list** — every methodology
sentence `methodologyFor` can produce (verified by reading all branches in
`pricing.ts`, including the USDC/WETH fast-path variants) is composed only from these
three literal strings plus fixed surrounding prose. No other substring (e.g. "the
oracle" on its own, "WETH/USDC pool prices") needs matching, and none of the three
phrases overlap or nest, so a single non-overlapping split is sufficient — no need for
priority ordering or longest-match logic.

`receiptView.tsx` swaps its plain `{methodologyText}` render for
`<MethodologyText text={methodologyText} />` at the Market Price footnote (currently
line ~230). No other call site renders a methodology sentence.

## Out of scope

- Styling/linking any text outside the Market Price footnote.
- Changing the wording of any methodology sentence in `pricing.ts`.
- A same-tab variant — new-tab is the explicit requirement.

## Test impact

`receiptView.test.tsx:974` currently asserts a raw-HTML `toContain` on the full
sentence `'Verified: The direct-pool price and WETH-derived price agree.'`. Once the
two phrases are wrapped in `<a>` tags, that literal substring no longer appears
verbatim in the output. Update the assertion to check for the wrapped structure
(anchor tags with `href="/methodology"` and `target="_blank"` around each phrase)
instead of the flat sentence. Also add a small dedicated test verifying:

- each of the three phrases renders as a `target="_blank"` anchor to `/methodology`
  when present in a methodology string,
- surrounding prose is preserved untouched,
- a sentence with no matching phrase (e.g. the `none`-tier "Unavailable: No reliable
  market price could be calculated.") renders with no anchors at all.
