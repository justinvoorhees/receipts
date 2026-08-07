// USD-anchor symbol sets, in a leaf module that imports nothing.
//
// These are shared by ReceiptView (base/quote orientation via symbolAnchorRank)
// and the quarantined receipt/qualityNotionals. They live here rather than in
// ReceiptView because ReceiptView is a 'use client' component — importing the
// sets from there would drag the entire client tree into any consumer,
// including a future server-side re-wire of qualityNotionals. A leaf module
// keeps the quarantined helpers genuinely importable in isolation.
export const STABLE_SYMBOLS = new Set(['USDC', 'USDbC', 'DAI']);
export const ETH_SYMBOLS = new Set(['WETH', 'ETH']);
