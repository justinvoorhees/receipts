import { Command } from 'commander';
import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildCandidates } from './buildCandidates.js';
import { buildReceipts } from './buildReceipts.js';
import { parseNonNegativeInt, parsePositiveInt } from './cliValidation.js';

/**
 * cliDerive.ts — the Derived-layer entry point.
 *
 * `candidates` needs no RPC. `receipts` does — it decodes serially against a
 * live endpoint, falling back to `prefetched` Seed payloads for the three
 * per-transaction reads `analyzeTransaction` would otherwise make itself.
 * Every path resolves from an argument against the process CWD at RUNTIME,
 * never from import.meta.url.
 */

config();

const program = new Command();

program
	.name('etl-derive')
	.description('Build Derived Parquet files from the Seed archive');

program
	.command('candidates')
	.description('One row per candidate swap transaction. Zero RPC.')
	.requiredOption('--seed <glob>', 'Seed Parquet path or glob')
	.requiredOption('--from <block>', 'first block of the range, for the filename')
	.requiredOption('--to <block>', 'last block of the range, for the filename')
	.requiredOption('--build <tag>', 'build directory under data/derived/')
	.option('--chain <name>', 'chain slug used in the filename', 'base')
	.option('--data-dir <path>', 'root of the data directory', 'data')
	.option('--routers <path>', 'router registry', 'configs/routers.json')
	.action(async (options) => {
		const fromBlock = parseNonNegativeInt(options.from, '--from');
		const toBlock = parseNonNegativeInt(options.to, '--to');

		const started = Date.now();
		const result = await buildCandidates({
			seedGlob: resolve(process.cwd(), options.seed),
			seedFile: options.seed,
			routersPath: resolve(process.cwd(), options.routers),
			dataDir: resolve(process.cwd(), options.dataDir),
			build: options.build,
			chain: options.chain,
			fromBlock,
			toBlock,
		});

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`${result.rowCount} candidate rows in ${seconds}s\n  → ${result.outPath}`);
	});

/** Collects a repeatable flag into an array, ignoring the default once the
 *  flag is actually passed — commander's own `previous` accumulator would
 *  otherwise start from the default and never let the caller replace it. */
function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

program
	.command('receipts')
	.description('Serially decode candidates into receipts + legs Parquet. Needs TCA_RPC_URL.')
	.requiredOption('--seed <glob>', 'Seed Parquet path or glob')
	.requiredOption('--candidates <glob>', 'candidates Parquet path or glob')
	.requiredOption('--from <block>', 'first block of the range, for the filename')
	.requiredOption('--to <block>', 'last block of the range, for the filename')
	.requiredOption('--build <tag>', 'build directory under data/derived/')
	.option('--chain <name>', 'chain slug used in the filename', 'base')
	.option('--chain-id <id>', 'numeric chain id', '8453')
	.option('--data-dir <path>', 'root of the data directory', 'data')
	.option(
		'--selected-via <via>',
		"repeatable: 'router' | 'swap_log' | 'both'; defaults to 'both' alone",
		collect,
		[],
	)
	.option('--limit <n>', 'stop after this many candidates')
	.option('--rpc-source <label>', 'provenance label; never a URL', 'quicknode-base-mainnet')
	.action(async (options) => {
		const rpcUrl = process.env.TCA_RPC_URL;
		if (!rpcUrl) throw new Error('TCA_RPC_URL is not set (export it or put it in .env)');

		const fromBlock = parseNonNegativeInt(options.from, '--from');
		const toBlock = parseNonNegativeInt(options.to, '--to');
		const chainId = parsePositiveInt(options.chainId, '--chain-id');
		const selectedVia: string[] = options.selectedVia.length > 0 ? options.selectedVia : ['both'];
		const coreGitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

		const started = Date.now();
		const result = await buildReceipts({
			seedGlob: resolve(process.cwd(), options.seed),
			seedFile: options.seed,
			candidatesGlob: resolve(process.cwd(), options.candidates),
			selectedVia,
			dataDir: resolve(process.cwd(), options.dataDir),
			build: options.build,
			chain: options.chain,
			chainId,
			fromBlock,
			toBlock,
			rpcUrl,
			rpcSource: options.rpcSource,
			coreGitSha,
			...(options.limit === undefined ? {} : { limit: parsePositiveInt(options.limit, '--limit') }),
			onProgress: (done, total) => {
				if (done % 25 === 0 || done === total) console.log(`  receipts ${done}/${total}`);
			},
		});

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`\n${result.attempted} attempted, ${result.decoded} decoded, ${result.failed} failed, ` +
				`${result.legRows} leg rows, in ${seconds}s\n  → ${result.receiptsPath}\n  → ${result.legsPath}`,
		);
	});

await program.parseAsync(process.argv);
