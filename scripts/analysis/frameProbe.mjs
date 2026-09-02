/**
 * frameProbe.mjs — how many qualifying trades does each aggregator actually
 * produce in a 6h window?
 *
 * The gating measurement for a receipt corpus. Every sampling design downstream
 * (how many per aggregator, how wide a window, where to put the notional
 * threshold) rests on a number nobody has measured: the ALL-PAIRS rate of
 * trades above a size threshold, per aggregator. The only figure we have is
 * from 2026-06-18 and it is scoped to USDC↔WETH/ETH — roughly 62% of router
 * calls were dropped as out-of-pair and never sized at all.
 *
 * This screens candidates cheaply and COUNTS them. It does not decode: no
 * trace, no pricing, no `analyzeTransaction`. One `eth_getTransactionReceipt`
 * per candidate against ~130 RPC calls for a real decode.
 *
 * ⚠️⚠️ 0x MUST be matched on the 57 Deployer settler addresses, not on
 * `routers.json`. The only 0x entry in routers.json is
 * 0xdef1c0ded9bec7f1a1670819833240f027b25eff — the RETIRED ExchangeProxy,
 * flagged "kept for provenance only" in aggregatorSignatures.ts, and NOT in the
 * settler set. June's discovery pass reported "0x — 0 router calls (inactive at
 * registered Base address)"; that is fully explained by scanning the dead
 * proxy. `resolveAggregator` resolves 0x through the settler registry, so this
 * script does too. **"0x is dead on Base" is untested.**
 *
 * ⚠️ Five aggregators have MORE THAN ONE active router address (1inch,
 * Nordstern, Velora, Odos, OKX). Match the whole address set per name.
 *
 * ⚠️ Safe to run concurrently, unlike anything that decodes. The
 * non-determinism in [transient-rpc-silently-degrades-receipts] lives in the
 * pricing and pool-discovery paths, which this never touches. The one rule that
 * still holds: a failed receipt fetch is `unreadable`, NEVER "no anchor" or
 * "small" — transport failure must not become evidence about the trade.
 *
 * Read-only. Writes nothing unless --out is passed.
 * Costs roughly 77k RPC calls for the default 3 windows (~32k block fetches,
 * ~45k receipts) — minutes at the default concurrency.
 *
 *   node scripts/analysis/frameProbe.mjs
 *   node scripts/analysis/frameProbe.mjs --threshold=100 --windows=3 --seed=42
 *   node scripts/analysis/frameProbe.mjs --hours=1 --windows=1        # smoke test
 *   node scripts/analysis/frameProbe.mjs --out=/tmp/frame.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from './_env.mjs';

const rpcUrl = env.TCA_RPC_URL;
if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};

const THRESHOLD = Number(flag('threshold', 100));
const WINDOWS = Number(flag('windows', 3));
const HOURS = Number(flag('hours', 6));
const SEED = Number(flag('seed', 1));
// 10 is the measured knee for full-block fetches on this endpoint; 20 rate-limits.
const CONCURRENCY = Number(flag('concurrency', 10));
const MAX_RETRIES = Number(flag('retries', 5));
/** Pin the window origin so --seed actually reproduces a run. Defaults to the
 *  chain tip, which MOVES — the run prints the anchor it used so it can be replayed. */
const ANCHOR = flag('anchor', null);
const OUT = flag('out', null);

/** Base produces a block every 2 seconds. */
const BLOCKS_PER_HOUR = 1800;
const WINDOW_BLOCKS = Math.max(1, Math.round(HOURS * BLOCKS_PER_HOUR));
/** At least one price sample, even for a fractional --hours smoke run. */
const PRICE_SAMPLES = Math.max(1, Math.ceil(HOURS));
const WEEK_BLOCKS = 24 * 7 * BLOCKS_PER_HOUR;

// ── Address sets ─────────────────────────────────────────────────────────────

const cfg = (name) =>
	JSON.parse(readFileSync(new URL(`../../configs/${name}`, import.meta.url), 'utf8'));

/**
 * lowercased `to` address → aggregator name.
 *
 * Mirrors resolveAggregator's precedence: the settler registry first (tier 1),
 * then curated routers (tier 2). Settlers win a collision, which is why they
 * are written second here.
 */
function buildAddressMap() {
	const map = new Map();
	for (const r of cfg('routers.json').routers) {
		if (!r.active) continue;
		if (r.detection !== 'to_address') continue; // solver_eoa is not `to`-matchable
		map.set(r.address.toLowerCase(), r.name);
	}
	for (const s of cfg('settlers.json').settlers) {
		map.set(s.address.toLowerCase(), '0x');
	}
	return map;
}

/** Routers we cannot see by `to`, reported so the exclusion is never silent. */
function unmatchableRouters() {
	return cfg('routers.json')
		.routers.filter((r) => r.active && r.detection !== 'to_address')
		.map((r) => `${r.name} (${r.detection})`);
}

// ── Anchors ──────────────────────────────────────────────────────────────────
// Same four the decoder uses (packages/core/src/receiptPure.ts).

const WETH = '0x4200000000000000000000000000000000000006';
const ANCHORS = {
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { dec: 6, usd: () => 1 },        // USDC
	'0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { dec: 6, usd: () => 1 },        // USDbC
	'0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { dec: 18, usd: () => 1 },       // DAI
	[WETH]: { dec: 18, usd: (ethUsd) => ethUsd },
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** WETH wrap/unwrap. Native ETH never appears as a Transfer, so without these a
 *  user selling ETH for a non-anchor token is unsizeable. June measured those
 *  at ~5% of genuine trades. */
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** Three deepest WETH/USDC pool on Base; token0 = WETH (benchmarkPrice.ts). */
const ETH_USD_POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224';

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

let callCount = 0;
let retryCount = 0;

/**
 * ⚠️⚠️ `res.ok` is checked FIRST and a non-200 is never parsed as a result.
 *
 * This endpoint rate-limits with **HTTP 429**, and a 429 body is not a JSON-RPC
 * error object — it has neither `result` nor `error`. A version of this function
 * that went straight to `res.json()` returned `undefined`, which the callers
 * read as "block has no transactions" and "receipt is null". Rate limiting
 * became SILENT DATA LOSS: blocks skipped, candidates never counted, and every
 * per-aggregator number biased downward with nothing to show for it.
 *
 * Measured 2026-09-02 on 120 week-old `eth_getBlockByNumber` calls:
 *
 *   concurrency  1 → 120 ok,  0 rate-limited, 12.7s
 *   concurrency  4 → 120 ok,  0 rate-limited,  3.1s
 *   concurrency 10 → 120 ok,  0 rate-limited,  1.3s   ← the knee
 *   concurrency 20 →  86 ok, 34 rate-limited,  0.6s
 *   concurrency 40 →  47 ok, 73 rate-limited,  0.4s
 *
 * ⚠️ This does NOT match `rpcCapacity.mjs`'s "concurrency 20-40" finding. That
 * measured cheap `eth_call`s; a full-transaction block fetch is far heavier and
 * throttles much earlier. The "parallelizes 26x" number is per-method — do not
 * carry it across.
 */
async function rpc(method, params, attempt = 0) {
	callCount++;
	let res;
	try {
		res = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: callCount, method, params }),
		});
	} catch (err) {
		if (attempt < MAX_RETRIES) return backoffRetry(method, params, attempt);
		throw new Error(`${method}: transport ${err.message}`);
	}

	if (res.status === 429 || res.status >= 500) {
		if (attempt < MAX_RETRIES) return backoffRetry(method, params, attempt);
		throw new Error(`${method}: HTTP ${res.status} after ${MAX_RETRIES} retries`);
	}
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);

	const json = await res.json();
	if (json.error) throw new Error(`${method}: ${json.error.message}`);
	return json.result;
}

function backoffRetry(method, params, attempt) {
	retryCount++;
	const ms = 150 * 2 ** attempt + Math.random() * 100;
	return new Promise((r) => setTimeout(r, ms)).then(() => rpc(method, params, attempt + 1));
}

/** Bounded-concurrency map. Preserves input order in the output. */
async function pool(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

// ── Seeded RNG, so a window selection is reproducible ────────────────────────

function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Window starts drawn from the last week, spread across the day.
 *
 * A single 6h window is one cluster — it shares a volatility regime, a gas
 * regime, and a time-of-day volume profile. US-hours and Asia-hours DEX volume
 * differ enough that one draw can sit 2-3x off the weekly average. Draws are
 * therefore rejected if they land in a third of the day already taken, so the
 * windows cover morning/afternoon/night rather than clustering by luck.
 */
function pickWindows(latestBlock, count, rand) {
	const oldest = latestBlock - WEEK_BLOCKS;
	const usable = WEEK_BLOCKS - WINDOW_BLOCKS;
	const takenThirds = new Set();
	const starts = [];

	for (let attempt = 0; attempt < 500 && starts.length < count; attempt++) {
		const start = oldest + Math.floor(rand() * usable);
		// Approximate UTC hour from block height: blocks are 2s and the chain
		// does not skip, so height modulo a day is a faithful clock.
		const hourOfDay = Math.floor(((start % (24 * BLOCKS_PER_HOUR)) / BLOCKS_PER_HOUR));
		const third = Math.floor(hourOfDay / 8);
		if (takenThirds.size < 3 && takenThirds.has(third)) continue;
		takenThirds.add(third);
		starts.push(start);
	}
	// If rejection sampling could not fill the quota (count > 3), top up freely.
	while (starts.length < count) starts.push(oldest + Math.floor(rand() * usable));
	return starts.sort((a, b) => a - b);
}

// ── Screen ───────────────────────────────────────────────────────────────────

/**
 * Size proxy: the LARGEST anchor-token amount moved anywhere in the transaction.
 *
 * Deliberately not the trader's net flow. Net flow needs the beneficiary, which
 * for relayed and 4337 transactions is not tx.from, and it cannot see native ETH
 * without a trace. The max-anchor proxy is robust to both: on a linear route
 * every anchor leg is approximately the notional, so the maximum is a good
 * stand-in.
 *
 * ⚠️ It is biased to OVER-estimate — a batch settling several users' trades
 * sizes as the batch total. That is the safe direction for a screen (over-
 * include, then let the decode adjudicate), but it means these counts are an
 * UPPER bound on how many transactions clear the threshold. The agreement study
 * against a real decode is what converts this proxy into a calibrated one.
 */
function sizeFromLogs(logs, ethUsd) {
	let maxUsd = 0;
	let sawAnchor = false;

	for (const log of logs) {
		const addr = (log.address ?? '').toLowerCase();
		const t0 = log.topics?.[0];
		if (!t0) continue;

		if (t0 === TRANSFER_TOPIC && log.topics.length === 3) {
			const anchor = ANCHORS[addr];
			if (!anchor) continue;
			sawAnchor = true;
			const raw = BigInt(log.data === '0x' ? '0x0' : log.data);
			const usd = (Number(raw) / 10 ** anchor.dec) * anchor.usd(ethUsd);
			if (usd > maxUsd) maxUsd = usd;
		} else if (addr === WETH && (t0 === DEPOSIT_TOPIC || t0 === WITHDRAWAL_TOPIC)) {
			// Native ETH entering or leaving the trade via the WETH contract.
			sawAnchor = true;
			const raw = BigInt(log.data === '0x' ? '0x0' : log.data);
			const usd = (Number(raw) / 1e18) * ethUsd;
			if (usd > maxUsd) maxUsd = usd;
		}
	}
	return sawAnchor ? maxUsd : null;
}

/** ETH/USD from the reference pool's slot0. One read per hour is plenty: ETH
 *  moves 1-3% over a 6h window, which at a $100 line is a ±$1-3 boundary
 *  error. Per-block pricing would double the probe's cost for nothing. */
async function ethUsdAt(blockHex) {
	const data = await rpc('eth_call', [{ to: ETH_USD_POOL, data: '0x3850c7bd' }, blockHex]); // slot0()
	const sqrtPriceX96 = BigInt('0x' + data.slice(2, 66));
	const ratio = Number(sqrtPriceX96) / 2 ** 96;
	// token0 = WETH (18), token1 = USDC (6) -> multiply by 10^(18-6).
	return ratio * ratio * 1e12;
}

// ── Probe one window ─────────────────────────────────────────────────────────

async function probeWindow(startBlock, addressMap, label) {
	const endBlock = startBlock + WINDOW_BLOCKS - 1;
	const blocks = Array.from({ length: WINDOW_BLOCKS }, (_, i) => startBlock + i);

	console.error(`\n${label}  blocks ${startBlock}–${endBlock}  (${WINDOW_BLOCKS} blocks)`);

	// Hourly ETH price, keyed by the hour index within the window.
	const priceBlocks = Array.from({ length: PRICE_SAMPLES }, (_, h) =>
		Math.min(endBlock, startBlock + h * BLOCKS_PER_HOUR));
	const prices = await pool(priceBlocks, 4, (b) => ethUsdAt('0x' + b.toString(16)));
	const priceFor = (block) =>
		prices[Math.min(PRICE_SAMPLES - 1, Math.floor((block - startBlock) / BLOCKS_PER_HOUR))];
	console.error(`  eth/usd ${prices.map((p) => p.toFixed(0)).join(' → ')}`);

	// Pass 1 — scan blocks, match `to` against the address set.
	let totalTxs = 0;
	const blockFailures = [];
	const candidates = [];

	let scanned = 0;
	await pool(blocks, CONCURRENCY, async (b) => {
		let blk;
		try {
			blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]);
		} catch (err) {
			// ⚠️ NOT a skip. An unread block is candidates we never saw, which biases
			// every count in this report downward. It is reported, loudly.
			blockFailures.push(`${b}: ${err.message.slice(0, 60)}`);
			return;
		}
		if (!blk?.transactions) {
			blockFailures.push(`${b}: block returned without transactions`);
			return;
		}
		totalTxs += blk.transactions.length;
		for (const tx of blk.transactions) {
			const to = (tx.to ?? '').toLowerCase();
			const agg = addressMap.get(to);
			if (agg) candidates.push({ hash: tx.hash, block: b, aggregator: agg });
		}
		if (++scanned % 2000 === 0) console.error(`  scanned ${scanned}/${WINDOW_BLOCKS} blocks`);
	});

	console.error(`  ${totalTxs} txs, ${candidates.length} candidates` +
		(blockFailures.length ? `  ⚠️ ${blockFailures.length} UNREAD BLOCKS` : ''));

	// Pass 2 — screen each candidate on its receipt alone.
	let screened = 0;
	const rows = await pool(candidates, CONCURRENCY, async (c) => {
		let receipt;
		try {
			receipt = await rpc('eth_getTransactionReceipt', [c.hash]);
		} catch (err) {
			return { ...c, bucket: 'unreadable', sizeUsd: null, reason: err.message.slice(0, 90) };
		}
		if (++screened % 2000 === 0) console.error(`  screened ${screened}/${candidates.length}`);
		if (!receipt) return { ...c, bucket: 'unreadable', sizeUsd: null, reason: 'null receipt' };
		if (receipt.status === '0x0') return { ...c, bucket: 'reverted', sizeUsd: null };

		let sizeUsd;
		try {
			sizeUsd = sizeFromLogs(receipt.logs ?? [], priceFor(c.block));
		} catch (err) {
			// A log we could not parse is not evidence that the trade was small.
			return { ...c, bucket: 'unreadable', sizeUsd: null, reason: `log parse: ${err.message.slice(0, 70)}` };
		}
		if (sizeUsd == null) return { ...c, bucket: 'no_anchor', sizeUsd: null };
		return { ...c, bucket: sizeUsd >= THRESHOLD ? 'qualifying' : 'below', sizeUsd };
	});

	return { label, startBlock, endBlock, totalTxs, blockFailures, rows };
}

// ── Reporting ────────────────────────────────────────────────────────────────

const BUCKETS = ['qualifying', 'below', 'no_anchor', 'reverted', 'unreadable'];

function tally(rows, names) {
	const t = new Map(names.map((n) => [n, Object.fromEntries(BUCKETS.map((b) => [b, 0]))]));
	for (const r of rows) {
		const row = t.get(r.aggregator);
		if (row) row[r.bucket]++;
	}
	return t;
}

function printTable(title, rows, names) {
	const t = tally(rows, names);
	const withAny = names
		.map((n) => [n, t.get(n)])
		.map(([n, c]) => [n, c, BUCKETS.reduce((s, b) => s + c[b], 0)])
		.sort((a, b) => b[2] - a[2]);

	console.log(`\n${title}`);
	console.log(
		'  ' +
			'aggregator'.padEnd(14) +
			'cands'.padStart(8) +
			`≥$${THRESHOLD}`.padStart(8) +
			'below'.padStart(8) +
			'no_anchor'.padStart(11) +
			'revert'.padStart(8) +
			'unread'.padStart(8) +
			'  qual%',
	);
	console.log('  ' + '─'.repeat(72));

	const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	for (const [name, c, total] of withAny) {
		for (const b of BUCKETS) totals[b] += c[b];
		const pct = total ? ((c.qualifying / total) * 100).toFixed(1) : '—';
		console.log(
			'  ' +
				name.padEnd(14) +
				String(total).padStart(8) +
				String(c.qualifying).padStart(8) +
				String(c.below).padStart(8) +
				String(c.no_anchor).padStart(11) +
				String(c.reverted).padStart(8) +
				String(c.unreadable).padStart(8) +
				'  ' +
				String(pct).padStart(5),
		);
	}
	const grand = BUCKETS.reduce((s, b) => s + totals[b], 0);
	console.log('  ' + '─'.repeat(72));
	console.log(
		'  ' +
			'TOTAL'.padEnd(14) +
			String(grand).padStart(8) +
			String(totals.qualifying).padStart(8) +
			String(totals.below).padStart(8) +
			String(totals.no_anchor).padStart(11) +
			String(totals.reverted).padStart(8) +
			String(totals.unreadable).padStart(8) +
			'  ' +
			String(grand ? ((totals.qualifying / grand) * 100).toFixed(1) : '—').padStart(5),
	);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const addressMap = buildAddressMap();
const names = [...new Set(addressMap.values())].sort();
const excluded = unmatchableRouters();

console.error(`frameProbe — ${names.length} aggregators, ${addressMap.size} addresses`);
console.error(`  threshold $${THRESHOLD} · ${WINDOWS}× ${HOURS}h windows · seed ${SEED} · concurrency ${CONCURRENCY}`);
console.error(`  0x matched on ${cfg('settlers.json').settlers.length} settler addresses, NOT the retired ExchangeProxy`);
if (excluded.length) console.error(`  ⚠️  not \`to\`-matchable, excluded from frame: ${excluded.join(', ')}`);

const tip = Number(await rpc('eth_blockNumber'));
const latest = ANCHOR ? Number(ANCHOR) : tip;
console.error(`  anchor block ${latest}${ANCHOR ? ' (pinned)' : ` (chain tip; pass --anchor=${latest} to replay)`}`);
const starts = pickWindows(latest, WINDOWS, mulberry32(SEED));

const results = [];
for (const [i, start] of starts.entries()) {
	results.push(await probeWindow(start, addressMap, `window ${i + 1}/${starts.length}`));
}

const allRows = results.flatMap((r) => r.rows);

for (const r of results) {
	printTable(
		`${r.label} — blocks ${r.startBlock}–${r.endBlock} · ${r.totalTxs} txs in window`,
		r.rows,
		names,
	);
}
if (results.length > 1) printTable(`ALL ${results.length} WINDOWS COMBINED`, allRows, names);

const totalTxs = results.reduce((s, r) => s + r.totalTxs, 0);
const qualifying = allRows.filter((r) => r.bucket === 'qualifying').length;
const noAnchor = allRows.filter((r) => r.bucket === 'no_anchor').length;

console.log(`\nFrame`);
console.log(`  router calls / all txs   ${allRows.length} / ${totalTxs}  (${((allRows.length / totalTxs) * 100).toFixed(2)}%)`);
console.log(`  qualifying ≥$${THRESHOLD}        ${qualifying}  (${((qualifying / allRows.length) * 100).toFixed(2)}% of router calls)`);
console.log(`  unsizeable (no_anchor)   ${noAnchor}  (${((noAnchor / allRows.length) * 100).toFixed(2)}% of router calls)`);
console.log(`  RPC calls issued         ${callCount}  (${retryCount} retried after 429/5xx)`);

const unreadBlocks = results.reduce((s, r) => s + r.blockFailures.length, 0);
if (unreadBlocks) {
	console.log(`\n  ⚠️⚠️  ${unreadBlocks} BLOCKS COULD NOT BE READ — every count above is a`);
	console.log(`        LOWER bound. Re-run with a smaller --concurrency before trusting it.`);
	for (const r of results) for (const f of r.blockFailures.slice(0, 3)) console.log(`        ${f}`);
}

const unreadable = allRows.filter((r) => r.bucket === 'unreadable');
if (unreadable.length) {
	const byReason = new Map();
	for (const r of unreadable) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
	console.log(`\n  ⚠️  ${unreadable.length} unreadable — a screen that cannot read is not evidence:`);
	for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
		console.log(`      ${String(n).padStart(6)}  ${reason}`);
	}
}
console.log(`\n  ⚠️  Size is a max-anchor PROXY and biased to over-estimate — these are an`);
console.log(`      UPPER bound on qualifying counts. no_anchor is UNMEASURED, not small.`);
console.log(`\n  Reproduce: --anchor=${latest} --seed=${SEED} --windows=${WINDOWS} --hours=${HOURS} --threshold=${THRESHOLD}`);

if (OUT) {
	writeFileSync(
		OUT,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				params: { threshold: THRESHOLD, windows: WINDOWS, hours: HOURS, seed: SEED },
				latestBlock: latest,
				excludedRouters: excluded,
				settlerCount: cfg('settlers.json').settlers.length,
				anchorBlock: latest,
				retries: retryCount,
				windows: results.map(({ rows, ...meta }) => ({ ...meta, rowCount: rows.length })),
				rows: allRows,
			},
			null,
			2,
		),
	);
	console.log(`\n  wrote ${OUT}`);
}
