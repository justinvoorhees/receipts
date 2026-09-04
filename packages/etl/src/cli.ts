import { config } from 'dotenv';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { assertFromToPaired, parseNonNegativeInt, parsePositiveInt } from './cliValidation.js';
import { DEFAULT_MAX_BLOCKS, finalizedWindow, ingestRange } from './ingest.js';

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
	.option('--concurrency <n>', 'blocks fetched in parallel', '4')
	.option(
		'--max-blocks <n>',
		'sanity ceiling on the range size; ingest is all-or-nothing',
		String(DEFAULT_MAX_BLOCKS),
	)
	.option('--allow-unfinalized', 'write past the finalized head, into seeds/provisional/', false)
	.action(async (options) => {
		const rpcUrl = process.env.TCA_RPC_URL;
		if (!rpcUrl) throw new Error('TCA_RPC_URL is not set (export it or put it in .env)');

		// Every check below runs before any RPC call — a bad flag should name
		// itself immediately, not after eth_getBlockByNumber has already gone
		// out, and never by silently substituting a different range.
		assertFromToPaired(options.from, options.to);
		const explicit = options.from !== undefined && options.to !== undefined;
		const concurrency = parsePositiveInt(options.concurrency, '--concurrency');
		const maxBlocks = parsePositiveInt(options.maxBlocks, '--max-blocks');
		// Was `Number(options.chainId)`: `--chain-id abc` gave NaN, which
		// JSON.stringify renders as `null`, which DuckDB writes as NULL on
		// every row of an immutable file, with no error at any layer.
		const chainId = parsePositiveInt(options.chainId, '--chain-id');

		const { fromBlock, toBlock } = explicit
			? {
					fromBlock: parseNonNegativeInt(options.from, '--from'),
					toBlock: parseNonNegativeInt(options.to, '--to'),
				}
			: await finalizedWindow(rpcUrl, parsePositiveInt(options.span, '--span'));

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
			chainId,
			fromBlock,
			toBlock,
			dataDir: resolve(process.cwd(), options.dataDir),
			source: options.source,
			allowUnfinalized: Boolean(options.allowUnfinalized),
			concurrency,
			maxBlocks,
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
