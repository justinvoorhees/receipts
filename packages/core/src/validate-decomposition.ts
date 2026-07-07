/**
 * validate-decomposition.ts — Runs decomposeTrade on 7 curated txns and
 * prints the full 3-way cost breakdown for each.
 *
 * READ-ONLY spike — no DB writes, no pipeline edits.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/validate-decomposition.ts
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { decomposeTrade } from './decompose-trade.js';
import type { Direction } from './tradeEndpoints.js';

// ─── Curated transactions ───

const CURATED_TXS = [
	{
		hash: '0x55513d402ecdbc00fea0eaf68642442193aeff6385b48e9339745fedd66e965a' as const,
		label: '#1 1inch RFQ — no V3 swaps, agg fee 0, all-in −18.52 (beat mid)',
	},
	{
		hash: '0x89628ee8e6b3a1b7c4c8ab8af5a5752c6de2ba7024ea0ff78a155a044c59aa8c' as const,
		label: '#2 Odos — skim/fee-sink 0xe093, ETH-settled, agg fee > all-in',
	},
	{
		hash: '0xce4dbac465b0538d1d484f2c1c0553861301248dbb6596dd448adfbfc6d31686' as const,
		label: '#3 Velora — explicit fee vault 0x0070, multi-hop V3, ETH-settled',
	},
	{
		hash: '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9' as const,
		label: '#4 Fabric — V3 + V4, the broken LP=200 case',
	},
	{
		hash: '0x850df6157d218bfb6cdfc2bb35cb59da640c6795447c0a89484b781a12a5cfcf' as const,
		label: '#5 KyberSwap — multi-hop V3, $13.3k, all-in −13.59',
	},
	{
		hash: '0x8503cccf97055770c778183859da64a19983a9014185a29b0a30f6845cc1d86e' as const,
		label: '#6 Relay — ETH-settled buy, all-in 42.47',
	},
	{
		hash: '0x15290f78247cf614f0531f8075d0949f572ae7ae22fd7bb19409f21435b9e282' as const,
		label: '#7 1inch — clean single-V3 hop (1 bps pool), WETH-settled sell',
	},
];

// ─── Main ───

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const sql = postgres(dbUrl);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	console.log('╔═══════════════════════════════════════════════════════════════════╗');
	console.log('║  Cost Decomposition v2.1 — Validation Spike (7 curated txns)     ║');
	console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

	const hashes = CURATED_TXS.map(t => t.hash);
	const rows = await sql`
		SELECT tx_hash, trader, aggregator, direction, settled_in,
		       all_in_cost_bps, usdc_amount, weth_amount, realized_price,
		       gas_cost_usd, market_mid, block_number
		FROM router_trades
		WHERE tx_hash IN ${sql(hashes)}
	`;

	// Index by tx_hash
	const rowMap = new Map<string, typeof rows[number]>();
	for (const r of rows) {
		rowMap.set(r.tx_hash, r);
	}

	for (const txn of CURATED_TXS) {
		const row = rowMap.get(txn.hash);
		if (!row) {
			console.log(`\n*** SKIPPING ${txn.label}: not found in router_trades ***\n`);
			continue;
		}

		console.log('═══════════════════════════════════════════════════════════════════');
		console.log(`  ${txn.label}`);
		console.log(`  ${txn.hash}`);
		console.log(`  ${row.aggregator} | ${row.direction} | settled: ${row.settled_in}`);
		console.log('───────────────────────────────────────────────────────────────────');

		// Fetch debug trace
		const rawTrace = await (
			rpc.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
		)({
			method: 'debug_traceTransaction',
			params: [
				txn.hash,
				{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
			],
		});

		const result = await decomposeTrade({
			trace: rawTrace as Parameters<typeof decomposeTrade>[0]['trace'],
			txHash: txn.hash,
			trader: row.trader,
			direction: row.direction as Direction,
			settledIn: row.settled_in as 'WETH' | 'ETH',
			allInCostBps: Number(row.all_in_cost_bps),
			notionalUsdc: Math.abs(Number(row.usdc_amount)),
			realizedPrice: Number(row.realized_price),
			gasCostUsd: Number(row.gas_cost_usd),
			aggregator: row.aggregator,
			blockNumber: BigInt(row.block_number),
			rpcUrl,
		});

		// Print notional
		console.log(`  Notional: $${Math.abs(Number(row.usdc_amount)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`);
		console.log(`  Realized price: ${Number(row.realized_price).toFixed(4)} USDC/WETH`);
		console.log(`  Market mid (N-1): ${Number(row.market_mid).toFixed(4)} USDC/WETH`);
		console.log('');

		// Hops table
		console.log('  Hops:');
		console.log('    Venue                                      Type   Tier(bps)  Notional($)      %');
		console.log('    ─────────────────────────────────────────────────────────────────────────────────');
		for (const h of result.hops) {
			const addrDisplay = h.address.length > 20
				? `${h.address.slice(0, 6)}...${h.address.slice(-4)}`
				: h.address;
			console.log(
				`    ${addrDisplay.padEnd(46)} ${h.type.padEnd(6)} ${h.feeTierBps.toFixed(2).padStart(8)}  ` +
				`${h.notionalUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(13)}  ${h.pctOfTotal.toFixed(1).padStart(5)}%`,
			);
		}
		console.log('');

		// Fee sinks
		if (result.feeSinks.length > 0) {
			console.log('  Fee sinks:');
			console.log('    Address                                      USDC         WETH       Total($)   Source');
			console.log('    ──────────────────────────────────────────────────────────────────────────────────────────');
			for (const s of result.feeSinks) {
				const addrDisplay = `${s.address.slice(0, 6)}...${s.address.slice(-4)}`;
				console.log(
					`    ${addrDisplay.padEnd(46)} ${s.usdcRetained.toFixed(4).padStart(10)}  ` +
					`${s.wethRetained.toFixed(6).padStart(12)}  ${s.totalUsdc.toFixed(4).padStart(10)}   ${s.source}`,
				);
			}
			console.log('');
		} else {
			console.log('  Fee sinks: (none)\n');
		}

		// Decomposition
		const allIn = Number(row.all_in_cost_bps);
		const isPure = result.lpFeeBps !== null;

		console.log('  Decomposition:');
		if (isPure) {
			const sum = result.lpFeeBps! + result.aggFeeBps + result.slippageBps!;
			const delta = Math.abs(sum - allIn);
			const reconciled = delta < 0.01;

			console.log(`    LP fee:       ${result.lpFeeBps!.toFixed(4).padStart(10)} bps`);
			console.log(`    Agg fee:      ${result.aggFeeBps.toFixed(4).padStart(10)} bps`);
			console.log(`    Slippage:     ${result.slippageBps!.toFixed(4).padStart(10)} bps  (signed residual)`);
			console.log(`    Execution:    ${result.executionBps!.toFixed(4).padStart(10)} bps  (LP + slippage)`);
			console.log(`    Gas:          ${result.gasBps.toFixed(4).padStart(10)} bps  ($${Number(row.gas_cost_usd).toFixed(6)})`);
			console.log('    ─────────────────────────────────');
			console.log(`    LP+Agg+Slip:  ${sum.toFixed(4).padStart(10)} bps`);
			console.log(`    all_in_cost:  ${allIn.toFixed(4).padStart(10)} bps`);
			console.log(`    Reconciled:   ${reconciled ? 'YES' : `MISMATCH (delta = ${delta.toFixed(4)} bps)`}`);
		} else {
			// IMPURE route — LP/slippage not separable
			const sum = result.aggFeeBps + result.executionBps!;
			const delta = Math.abs(sum - allIn);
			const reconciled = delta < 0.01;

			// Extract third-token names from flags
			const multiHopFlag = result.flags.find(f => f.startsWith('MULTI-HOP:'));
			const thirdTokens = multiHopFlag
				? multiHopFlag.replace('MULTI-HOP: route touches ', '').replace(' — LP/slippage not separable', '')
				: '(unknown)';

			console.log(`    LP fee:            n/a  (multi-hop route)`);
			console.log(`    Slippage:          n/a  (multi-hop route)`);
			console.log(`    Agg fee:      ${result.aggFeeBps.toFixed(4).padStart(10)} bps`);
			console.log(`    Execution:    ${result.executionBps!.toFixed(4).padStart(10)} bps  (all_in − agg)`);
			console.log(`    Gas:          ${result.gasBps.toFixed(4).padStart(10)} bps  ($${Number(row.gas_cost_usd).toFixed(6)})`);
			console.log(`    Third tokens: ${thirdTokens}`);
			console.log('    ─────────────────────────────────');
			console.log(`    Agg+Exec:     ${sum.toFixed(4).padStart(10)} bps`);
			console.log(`    all_in_cost:  ${allIn.toFixed(4).padStart(10)} bps`);
			console.log(`    Reconciled:   ${reconciled ? 'YES' : `MISMATCH (delta = ${delta.toFixed(4)} bps)`}`);
		}
		console.log('');

		// Flags
		if (result.flags.length > 0) {
			console.log('  Flags:');
			for (const f of result.flags) {
				console.log(`    [${f}]`);
			}
		} else {
			console.log('  Flags: (none)');
		}
		console.log('');
	}

	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
