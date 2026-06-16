import 'dotenv/config';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { createDb } from '@fabric-tca/db';
import { loadRouterRegistry } from './routerRegistry.js';
import { POOLS, startPoller } from './poller.js';
import { decodeTransaction } from './decoder.js';
import { processSwap, recomputeP99 } from './processSwap.js';

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		throw new Error(`${name} is not set. Copy .env.example to .env and fill in this value.`);
	}
	return v;
}

export async function main(argv: readonly string[]) {
	const program = new Command()
		.name('tca-ingest')
		.description('Fabric TCA ingestion pipeline')
		.version('0.0.0');

	program
		.command('poll')
		.description('Run the eth_getLogs poller continuously')
		.option('--from <block>', 'block to resume from (default: current head)')
		.option('--registry <path>', 'router registry JSON path', 'configs/routers.json')
		.action(async (opts) => {
			const databaseUrl = requireEnv('TCA_DATABASE_URL');
			const rpcUrl = requireEnv('TCA_RPC_URL');
			const pollIntervalMs = Number(process.env.TCA_POLL_INTERVAL_MS ?? 2000);
			const db = createDb(databaseUrl);
			const registry = await loadRouterRegistry(resolve(process.cwd(), opts.registry));

			const abortController = new AbortController();
			process.on('SIGINT', () => {
				console.log('SIGINT received — stopping poller cleanly.');
				abortController.abort();
			});

			await startPoller({
				db,
				rpcUrl,
				pollIntervalMs,
				registry,
				pools: POOLS,
				...(opts.from ? { startBlock: BigInt(opts.from) } : {}),
				signal: abortController.signal,
			});
		});

	program
		.command('decode')
		.argument('<tx_hash>')
		.option('--pool <address>', 'pool address', POOLS[0]!.address)
		.option('--fee-tier <bps>', 'pool fee tier (500 | 3000)', String(POOLS[0]!.feeTier))
		.option('--aggregator <name>', 'aggregator label (for context only)', '')
		.description('Decode a single tx and dump its DecodedTx for inspection')
		.action(async (txHash: string, opts) => {
			const rpcUrl = requireEnv('TCA_RPC_URL');
			const result = await decodeTransaction({
				rpcUrl,
				txHash: txHash as `0x${string}`,
				context: {
					aggregator: opts.aggregator || null,
					poolAddress: opts.pool as `0x${string}`,
					poolFeeTier: Number(opts.feeTier),
				},
			});
			// rawTrace is huge; omit from the printed view but keep it on the
			// object for downstream consumers.
			const { rawTrace: _omit, ...summary } = result;
			void _omit;
			console.log(
				JSON.stringify(
					summary,
					(_, v) => (typeof v === 'bigint' ? v.toString() : v),
					2,
				),
			);
			console.log(`(rawTrace omitted; ${result.transfers.length} Transfer events extracted)`);
		});

	program
		.command('process')
		.argument('<tx_hash>')
		.option('--pool <address>', 'pool address', POOLS[0]!.address)
		.option('--fee-tier <bps>', 'pool fee tier (500 | 3000)', String(POOLS[0]!.feeTier))
		.option('--registry <path>', 'router registry JSON path', 'configs/routers.json')
		.description('Run the full promotion pipeline for one tx and write to the swaps table')
		.action(async (txHash: string, opts) => {
			const databaseUrl = requireEnv('TCA_DATABASE_URL');
			const rpcUrl = requireEnv('TCA_RPC_URL');
			const db = createDb(databaseUrl);
			const registry = await loadRouterRegistry(resolve(process.cwd(), opts.registry));
			const result = await processSwap({
				db,
				rpcUrl,
				txHash: txHash as `0x${string}`,
				poolAddress: opts.pool as `0x${string}`,
				poolFeeTier: Number(opts.feeTier),
				registry,
			});
			console.log(
				JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
			);
		});

	program
		.command('recompute-p99')
		.option('--window-days <n>', 'sample window in days', '30')
		.description('Recompute the P99 threshold from staging and persist')
		.action(async (opts) => {
			const databaseUrl = requireEnv('TCA_DATABASE_URL');
			const db = createDb(databaseUrl);
			const result = await recomputeP99(db, Number(opts.windowDays));
			console.log(
				`p99 threshold: $${result.thresholdUsd.toFixed(2)} (n=${result.sampleCount})`,
			);
		});

	await program.parseAsync([...argv]);
}

void main(process.argv);
