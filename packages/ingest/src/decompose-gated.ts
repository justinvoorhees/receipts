/**
 * decompose-gated.ts — Run decomposeTrade on every router_trades_gated row,
 * UPDATE each row's decomposition columns. Idempotent (re-runs overwrite).
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/decompose-gated.ts
 */

import postgres from 'postgres';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { decomposeTrade } from './decompose-trade.js';
import type { Direction } from './tradeEndpoints.js';

// ─── Types ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
	input?: `0x${string}`;
	output?: `0x${string}`;
	type?: string;
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

const CONCURRENCY = 4;

// ─── Main ───

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const sql = postgres(dbUrl);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Verify router_trades is untouched
	const rtCount = await sql`SELECT count(*)::int as n FROM router_trades`;
	console.log(`router_trades: ${rtCount[0]!.n} rows (untouched)`);

	// Read all gated rows
	const rows = await sql`
		SELECT tx_hash, trader, aggregator, direction, settled_in,
		       all_in_cost_bps, usdc_amount, weth_amount, realized_price,
		       market_mid, block_number
		FROM router_trades_gated
		ORDER BY block_number ASC
	`;
	console.log(`router_trades_gated: ${rows.length} rows to decompose\n`);

	let done = 0;
	let pureCount = 0;
	let impureCount = 0;
	let errorCount = 0;
	const lpFees: number[] = [];
	const aggFees: number[] = [];
	const slippages: number[] = [];
	const executions: number[] = [];
	const gasCosts: number[] = [];

	for (let i = 0; i < rows.length; i += CONCURRENCY) {
		const batch = rows.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (row) => {
				const txHash = row.tx_hash as string;
				try {
					// Fetch the receipt (for gas) and trace
					const [receipt, rawTrace] = await Promise.all([
						rpc.getTransactionReceipt({ hash: txHash as `0x${string}` }),
						(rpc.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>)({
							method: 'debug_traceTransaction',
							params: [
								txHash,
								{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
							],
						}),
					]);

					// Compute gas_cost_usd from receipt
					const gasUsed = Number(receipt.gasUsed);
					const effectiveGasPrice = Number(receipt.effectiveGasPrice);
					const gasCostEth = (gasUsed * effectiveGasPrice) / 1e18;
					const realizedPrice = Number(row.realized_price);
					// Value gas at the benchmark mid (same reference used for allInCostBps)
					const marketMid = Number(row.market_mid);
					const gasCostUsd = gasCostEth * marketMid;

					const result = await decomposeTrade({
						trace: rawTrace as TraceNode,
						txHash: txHash as `0x${string}`,
						trader: row.trader as string,
						direction: (row.direction as string) as Direction,
						settledIn: (row.settled_in as string) as 'WETH' | 'ETH',
						allInCostBps: Number(row.all_in_cost_bps),
						notionalUsdc: Math.abs(Number(row.usdc_amount)),
						realizedPrice,
						gasCostUsd,
						aggregator: row.aggregator as string,
						blockNumber: BigInt(row.block_number as number),
						rpcUrl,
					});

					const isPure = result.lpFeeBps !== null && result.slippageBps !== null;

					return {
						txHash,
						lpFeeBps: isPure ? result.lpFeeBps : null,
						aggFeeBps: result.aggFeeBps,
						slippageBps: isPure ? result.slippageBps : null,
						executionBps: !isPure ? result.executionBps : null,
						gasCostUsd,
						routePure: isPure,
						ok: true as const,
					};
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`  ERROR ${txHash}: ${msg}`);
					return { txHash, ok: false as const };
				}
			}),
		);

		for (const res of results) {
			if (!res.ok) {
				errorCount++;
				continue;
			}
			// UPDATE the row
			await sql`
				UPDATE router_trades_gated SET
					lp_fee_bps = ${res.lpFeeBps},
					agg_fee_bps = ${res.aggFeeBps},
					slippage_bps = ${res.slippageBps},
					execution_bps = ${res.executionBps},
					gas_cost_usd = ${res.gasCostUsd},
					route_pure = ${res.routePure}
				WHERE tx_hash = ${res.txHash}
			`;
			if (res.routePure) {
				pureCount++;
				lpFees.push(res.lpFeeBps!);
				slippages.push(res.slippageBps!);
			} else {
				impureCount++;
				executions.push(res.executionBps!);
			}
			aggFees.push(res.aggFeeBps);
			gasCosts.push(res.gasCostUsd);
		}

		done += batch.length;
		if (done % 20 === 0 || done === rows.length) {
			console.log(`  ...${done}/${rows.length} (pure: ${pureCount}, impure: ${impureCount}, errors: ${errorCount})`);
		}
	}

	// ── Stats ──
	const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
	const stdev = (arr: number[]) => {
		if (arr.length < 2) return 0;
		const m = avg(arr);
		return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
	};
	const med = (arr: number[]) => {
		if (arr.length === 0) return 0;
		const s = [...arr].sort((a, b) => a - b);
		const m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
	};

	console.log('\n══════════════════════════════════════════════════════════');
	console.log('  DECOMPOSITION REPORT');
	console.log('══════════════════════════════════════════════════════════');
	console.log(`\n  Total rows:    ${rows.length}`);
	console.log(`  PURE routes:   ${pureCount}`);
	console.log(`  IMPURE routes: ${impureCount}`);
	console.log(`  Errors:        ${errorCount}`);

	console.log('\n  Component stats (bps unless noted):');
	console.log(`    LP Fee    (pure only, n=${lpFees.length}):    avg=${avg(lpFees).toFixed(2)}  med=${med(lpFees).toFixed(2)}  stdev=${stdev(lpFees).toFixed(2)}`);
	console.log(`    Agg Fee   (all, n=${aggFees.length}):        avg=${avg(aggFees).toFixed(2)}  med=${med(aggFees).toFixed(2)}  stdev=${stdev(aggFees).toFixed(2)}`);
	console.log(`    Slippage  (pure only, n=${slippages.length}):    avg=${avg(slippages).toFixed(2)}  med=${med(slippages).toFixed(2)}  stdev=${stdev(slippages).toFixed(2)}`);
	console.log(`    Execution (impure only, n=${executions.length}):  avg=${avg(executions).toFixed(2)}  med=${med(executions).toFixed(2)}  stdev=${stdev(executions).toFixed(2)}`);
	console.log(`    Gas (USD) (all, n=${gasCosts.length}):        avg=$${avg(gasCosts).toFixed(6)}  med=$${med(gasCosts).toFixed(6)}  stdev=$${stdev(gasCosts).toFixed(6)}`);

	// Verify router_trades unchanged
	const rtAfter = await sql`SELECT count(*)::int as n FROM router_trades`;
	console.log(`\n  router_trades after: ${rtAfter[0]!.n} rows (should be ${rtCount[0]!.n})`);

	// Print a few sample rows for spot-check
	const samples = await sql`
		SELECT tx_hash, aggregator, route_pure, all_in_cost_bps,
		       lp_fee_bps, agg_fee_bps, slippage_bps, execution_bps, gas_cost_usd
		FROM router_trades_gated
		ORDER BY random()
		LIMIT 5
	`;
	console.log('\n  Sample rows:');
	for (const s of samples) {
		const isPure = s.route_pure;
		if (isPure) {
			const lp = Number(s.lp_fee_bps);
			const agg = Number(s.agg_fee_bps);
			const slip = Number(s.slippage_bps);
			const sum = lp + agg + slip;
			const allIn = Number(s.all_in_cost_bps);
			console.log(`    ${(s.tx_hash as string).slice(0, 10)}… ${s.aggregator} PURE  all_in=${allIn.toFixed(2)}  LP=${lp.toFixed(2)}+Agg=${agg.toFixed(2)}+Slip=${slip.toFixed(2)}=${sum.toFixed(2)}  gas=$${Number(s.gas_cost_usd).toFixed(6)}`);
		} else {
			const agg = Number(s.agg_fee_bps);
			const exec = Number(s.execution_bps);
			const sum = agg + exec;
			const allIn = Number(s.all_in_cost_bps);
			console.log(`    ${(s.tx_hash as string).slice(0, 10)}… ${s.aggregator} IMPURE  all_in=${allIn.toFixed(2)}  Agg=${agg.toFixed(2)}+Exec=${exec.toFixed(2)}=${sum.toFixed(2)}  gas=$${Number(s.gas_cost_usd).toFixed(6)}`);
		}
	}

	await sql.end();
	console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
