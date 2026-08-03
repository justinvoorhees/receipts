import { NextResponse } from 'next/server';
import { analyzeTransaction, enrichFeeSinkNames, type Receipt } from '@fabric-tca/core';
import {
	deleteReceipt,
	enrichLegRouters,
	getReceiptByHash,
	insertReceipt,
	type NewReceipt,
} from '../../../lib/queries.js';
import { clientKeyFromHeaders, createMemoryStore, createRateLimiter } from '../../../lib/rateLimit';
import { SESSION_COOKIE, verifySession } from '../../../lib/auth';

// core uses viem + fs (config load in tagging.ts) — must run on Node, not edge.
export const runtime = 'nodejs';
// Never statically cache: every paste is a fresh on-demand computation.
export const dynamic = 'force-dynamic';

const DEFAULT_CHAIN_ID = 8453; // Base

// Core hardwires viem's `base` chain, so any other id would store Base data
// under a false chain label. Accept only what we actually analyze.
const SUPPORTED_CHAIN_IDS = new Set([8453]);

const envInt = (name: string, fallback: number): number => {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/**
 * Two tiers, because the two paths differ in cost by more than an order of
 * magnitude: a fresh analysis is ~40 RPC calls (measured) plus a permanent DB
 * row, while a cache hit is one indexed read. Metering them together would
 * either throttle honest re-views or leave the expensive path effectively open.
 */
const requestLimiter = createRateLimiter(createMemoryStore(), {
	limit: envInt('RATE_LIMIT_REQUESTS_PER_MIN', 120),
	windowMs: 60_000,
});
const analysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: envInt('RATE_LIMIT_ANALYSES_PER_MIN', 20),
	windowMs: 60_000,
});

/**
 * Circuit breaker on total spend, counted across every client.
 *
 * POST /api/receipts is public, so per-IP limits alone do not bound the bill —
 * a flood just uses more IPs, and each new one arrives with a full budget. This
 * is the only ceiling a distributed source cannot walk around. It is blunt on
 * purpose: when it trips, receipt generation pauses for everyone rather than
 * quietly running up an RPC invoice.
 *
 * Sized in analyses/hour: at ~40 RPC calls each, the default caps a worst-case
 * hour at roughly 20k calls.
 */
const globalAnalysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: envInt('RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR', 500),
	windowMs: 60 * 60 * 1000,
});
const GLOBAL_KEY = 'global';

function tooMany(retryAfterSecs: number): Response {
	return NextResponse.json(
		{ error: 'Rate limit exceeded. Please slow down.' },
		{ status: 429, headers: { 'retry-after': String(retryAfterSecs) } },
	);
}

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
async function toNewReceipt(r: Receipt): Promise<NewReceipt> {
	return {
		txHash: r.txHash,
		chainId: r.chainId,
		aggregator: r.aggregator,
		routerAddress: r.routerAddress,
		trader: r.trader,
		fillerAddress: r.fillerAddress,
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
		tier: r.tier,
		methodology: r.methodology,
		marketPriceFlags: r.marketPriceFlags,
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
		feeRecipient: r.feeRecipient,
		feeSinkSource: r.feeSinkSource,
		feeSinks: await enrichFeeSinkNames(r.feeSinks),
		integratorFeeBps: num(r.integratorFeeBps),
		fabricFeeBps: num(r.fabricFeeBps),
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
	const client = clientKeyFromHeaders(req.headers);

	// Cheap ceiling first, so a flood is rejected before we parse or touch the DB.
	const overall = await requestLimiter(client);
	if (!overall.allowed) return tooMany(overall.retryAfterSecs);

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

	const chainId = body.chainId === undefined ? DEFAULT_CHAIN_ID : body.chainId;
	// Validated BEFORE the DB read and the analysis — rejecting afterwards would
	// still have paid the full RPC bill for a request we were never going to keep.
	if (typeof chainId !== 'number' || !Number.isInteger(chainId) || !SUPPORTED_CHAIN_IDS.has(chainId)) {
		return NextResponse.json(
			{ error: `Unsupported chainId. Supported: ${[...SUPPORTED_CHAIN_IDS].join(', ')}.` },
			{ status: 400 },
		);
	}

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

	// Only a cache MISS reaches the expensive tier, so honest re-views of an
	// already-analyzed trade never consume either budget.
	const analysis = await analysisLimiter(client);
	if (!analysis.allowed) return tooMany(analysis.retryAfterSecs);

	// Per-IP last, global check second-to-last: both are cheap, but the global
	// one is what holds when the caller can supply unlimited source addresses.
	const globalBudget = await globalAnalysisLimiter(GLOBAL_KEY);
	if (!globalBudget.allowed) {
		console.warn('[api/receipts] global analysis ceiling reached — pausing new analyses');
		return tooMany(globalBudget.retryAfterSecs);
	}

	const receipt = await analyzeTransaction(hash, chainId, { rpcUrl });
	if (!receipt) {
		return NextResponse.json({ error: 'Transaction not found.' }, { status: 404 });
	}

	// 3. Persist and return the stored row (so it also shows up in History).
	// Enrich here too, same as the cache-hit path above — otherwise the two
	// responses for the same hash have different shapes (legs missing `router`
	// on a fresh analysis, present on a cache hit).
	//
	// The cache check above is check-then-act: two concurrent requests for the
	// same unseen hash both miss and both analyze. The unique constraint now
	// rejects the loser, so resolve to whichever row won instead of 500ing. (This
	// was silently duplicating before — the old index was inert against NULL
	// user_id.) A conflict is the ONLY error swallowed here; anything else is a
	// genuine failure and must surface.
	try {
		const inserted = await insertReceipt(await toNewReceipt(receipt));
		return NextResponse.json(enrichLegRouters(inserted), { status: 200 });
	} catch (err) {
		const winner = await getReceiptByHash(hash);
		if (winner) return NextResponse.json(winner, { status: 200 });
		console.error('[api/receipts] insert failed', err);
		return NextResponse.json({ error: 'Could not store the receipt.' }, { status: 500 });
	}
}

/** Read the session cookie straight off the request header. */
function sessionTokenFrom(req: Request): string | undefined {
	const raw = req.headers.get('cookie');
	if (!raw) return undefined;
	for (const part of raw.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
	}
	return undefined;
}

/**
 * DELETE /api/receipts?id=<n> — removes a single receipt by its numeric id.
 * Used by the History table's per-row delete control. Returns 400 on a
 * missing/non-numeric id, 204 on success.
 *
 * Re-checks the session rather than trusting middleware. This is the only
 * destructive endpoint in the app, it takes no ownership check, and it was
 * previously reachable by anyone — a loop over ids emptied the table. Middleware
 * is one matcher regex away from silently not covering this path, so the
 * consequence of that mistake is worth a second check here.
 */
export async function DELETE(req: Request): Promise<Response> {
	const secret = process.env.APP_SESSION_SECRET;
	if (!secret || !(await verifySession(sessionTokenFrom(req), secret))) {
		return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
	}

	const id = Number(new URL(req.url).searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) {
		return NextResponse.json({ error: 'Missing or invalid receipt id.' }, { status: 400 });
	}
	await deleteReceipt(id);
	return new NextResponse(null, { status: 204 });
}
