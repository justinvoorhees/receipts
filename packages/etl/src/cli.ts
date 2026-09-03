import { config } from 'dotenv';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { finalizedWindow, ingestRange } from './ingest.js';

/**
 * cli.ts — the ingest entry point.
 *
 * The data directory is resolved from an argument or the process CWD at
 * RUNTIME, never from import.meta.url. The repo's six configs/*.json paths bake
 * the build machine's absolute path and work only because Nixpacks builds
 * in-container; nothing here may repeat that.
 */

config();

const program = new Command();

program
	.name('etl-ingest')
	.description('Ingest a Base block range into an immutable Seed Parquet file')
	.option('--from <block>', 'first block, inclusive')
	.option('--to <block>', 'last block, inclusive')
	.option('--span <count>', 'ingest the N blocks ending at the finalized head', '300')
	.option('--chain <name>', 'chain slug used in the filename', 'base')
	.option('--chain-id <id>', 'numeric chain id', '8453')
	.option('--data-dir <path>', 'root of the data directory', 'data')
	.option('--source <label>', 'provenance label; never a URL', 'quicknode-base-mainnet')
	.option('--concurrency <n>', 'blocks fetched in parallel', '8')
	.option('--allow-unfinalized', 'write past the finalized head, into seeds/provisional/', false)
	.action(async (options) => {
		const rpcUrl = process.env.TCA_RPC_URL;
		if (!rpcUrl) throw new Error('TCA_RPC_URL is not set (export it or put it in .env)');

		const explicit = options.from !== undefined && options.to !== undefined;
		const { fromBlock, toBlock } = explicit
			? { fromBlock: Number(options.from), toBlock: Number(options.to) }
			: await finalizedWindow(rpcUrl, Number(options.span));

		if (!explicit) {
			console.log(
				`No --from/--to given: ingesting the ${options.span} blocks ending at the ` +
					`finalized head. This range moves every run — pass --from/--to to reproduce it.`,
			);
		}

		const started = Date.now();
		const result = await ingestRange({
			rpcUrl,
			chain: options.chain,
			chainId: Number(options.chainId),
			fromBlock,
			toBlock,
			dataDir: resolve(process.cwd(), options.dataDir),
			source: options.source,
			allowUnfinalized: Boolean(options.allowUnfinalized),
			concurrency: Number(options.concurrency),
			onProgress: (done, total) => {
				if (done % 25 === 0 || done === total) console.log(`  blocks ${done}/${total}`);
			},
		});

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`\n${result.rowCount} rows from blocks ${result.fromBlock}-${result.toBlock} ` +
				`(${result.finality}) in ${seconds}s\n  → ${result.outPath}`,
		);
	});

await program.parseAsync(process.argv);
