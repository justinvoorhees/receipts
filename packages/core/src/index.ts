/**
 * @tca/core — public surface.
 *
 * The single on-demand entry point for the receipts tool: paste a tx hash,
 * get a `Receipt` (or `null`).
 */
export { analyzeTransaction, type Receipt } from './analyzeTransaction.js';
export { classifyTransaction } from './classifyTransaction.js';
export type { AnalyzeFailure, RelayerDetail, FailureReason } from './endpoints.js';
