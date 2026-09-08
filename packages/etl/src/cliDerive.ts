import { Command } from 'commander';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { buildCandidates } from './buildCandidates.js';
import { parseNonNegativeInt } from './cliValidation.js';

/**
 * cliDerive.ts — the Derived-layer entry point.
 *
 * No RPC, no TCA_RPC_URL. Every path resolves from an argument against the
 * process CWD at RUNTIME, never from import.meta.url.
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

await program.parseAsync(process.argv);
