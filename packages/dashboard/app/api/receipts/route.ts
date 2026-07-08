import { NextResponse } from 'next/server';
import { analyzeTransaction, type Receipt } from '@fabric-tca/core';
import { deleteReceipt, getReceiptByHash, insertReceipt, type NewReceipt } from '../../../lib/queries.js';

// core uses viem + fs (config load in tagging.ts) — must run on Node, not edge.
export const runtime = 'nodejs';
// Never statically cache: every paste is a fresh on-demand computation.
export const dynamic = 'force-dynamic';

const DEFAULT_CHAIN_ID = 8453; // Base

/** number|null → string|null for a Drizzle `numeric` column. */
function num(v: number | null | undefined): string | null {
	return v == null ? null : String(v);
}

/**
 * Map a computed `Receipt` (number-typed) to a `NewReceipt` insert row. Every
 * Drizzle `numeric` column takes a string, so number fields are stringified
 * (nulls preserved). jsonb (routeLegs, normalizeFlags) and the int/text/bool
 * columns pass through unchanged.
 */
function toNewReceipt(r: Receipt): NewReceipt {
	return {
		txHash: r.txHash,
		chainId: r.chainId,
		aggregator: r.aggregator,
		trader: r.trader,
		direction: r.direction,
		inputToken: r.inputToken,
		outputToken: r.outputToken,
		inputSymbol: r.inputSymbol,
		outputSymbol: r.outputSymbol,
		inputAmount: String(r.inputAmount),
		outputAmount: String(r.outputAmount),
		notionalUsd: num(r.notionalUsd),
		realizedPrice: num(r.realizedPrice),
		marketMid: num(r.marketMid),
		allInCostBps: num(r.allInCostBps),
		pricingStatus: r.pricingStatus,
		blockNumber: r.blockNumber,
		executionBps: num(r.executionBps),
		lpFeeBps: num(r.lpFeeBps),
		aggFeeBps: num(r.aggFeeBps),
		slippageBps: num(r.slippageBps),
		gasCostUsd: num(r.gasCostUsd),
		routePure: r.routePure,
		routeShape: r.routeShape,
		hopCount: r.hopCount,
		routeLegs: r.routeLegs,
		reconResidualBps: num(r.reconResidualBps),
		decompConfidence: r.decompConfidence,
		settlementEventName: r.settlementEventName,
		settlementEventTopic0: r.settlementEventTopic0,
		settlementEventSeen: r.settlementEventSeen,
		normalizeFlags: r.normalizeFlags,
		chainlinkPrice: num(r.chainlinkPrice),
		chainlinkDevBps: num(r.chainlinkDevBps),
		poolDivergenceBps: num(r.poolDivergenceBps),
		manipulationFlag: r.manipulationFlag,
		offchainPrice: num(r.offchainPrice),
		offchainDevBps: num(r.offchainDevBps),
		chainlinkStalenessSecs: num(r.chainlinkStalenessSecs),
	};
}

export async function POST(req: Request): Promise<Response> {
	let body: { hash?: unknown; chainId?: unknown };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
	}

	const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
	if (!hash) {
		return NextResponse.json({ error: 'Missing transaction hash.' }, { status: 400 });
	}
	const chainId = typeof body.chainId === 'number' ? body.chainId : DEFAULT_CHAIN_ID;

	// 1. Cheap idempotent hit: already computed & persisted → return as-is.
	const existing = await getReceiptByHash(hash);
	if (existing) {
		return NextResponse.json(existing, { status: 200 });
	}

	// 2. Compute on demand. analyzeTransaction never throws — returns null when it
	//    can't produce a receipt (bad hash, not a clean swap, unpriceable, …).
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) {
		return NextResponse.json({ error: 'Server misconfigured: TCA_RPC_URL not set.' }, { status: 500 });
	}

	const receipt = await analyzeTransaction(hash, chainId, { rpcUrl });
	if (!receipt) {
		return NextResponse.json({ error: 'Transaction not found.' }, { status: 404 });
	}

	// 3. Persist and return the stored row (so it also shows up in History).
	const inserted = await insertReceipt(toNewReceipt(receipt));
	return NextResponse.json(inserted, { status: 200 });
}

/**
 * DELETE /api/receipts?id=<n> — removes a single receipt by its numeric id.
 * Used by the History table's per-row delete control. Returns 400 on a
 * missing/non-numeric id, 204 on success.
 */
export async function DELETE(req: Request): Promise<Response> {
	const id = Number(new URL(req.url).searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) {
		return NextResponse.json({ error: 'Missing or invalid receipt id.' }, { status: 400 });
	}
	await deleteReceipt(id);
	return new NextResponse(null, { status: 204 });
}
