import 'dotenv/config';
import { Command } from 'commander';

// Skeleton: wires up the CLI surface. Individual commands (poll, decode-tx,
// recompute-p99, export) get implemented as their own modules and registered here.
export async function main(argv: readonly string[]) {
	const program = new Command()
		.name('tca-ingest')
		.description('Fabric TCA ingestion pipeline')
		.version('0.0.0');

	program
		.command('poll')
		.description('Run the eth_getLogs poller continuously')
		.action(async () => {
			// TODO: load registry, start poller loop, write to swaps_staging
			console.error('Not yet implemented.');
			process.exit(1);
		});

	program
		.command('decode')
		.argument('<tx_hash>')
		.description('Decode a single tx and compute TCA ledger (manual / debug)')
		.action(async () => {
			// TODO: implement single-tx pipeline (fetch receipt + trace + slot0,
			// compute components, write to swaps).
			console.error('Not yet implemented.');
			process.exit(1);
		});

	program
		.command('recompute-p99')
		.description('Recompute the P99 threshold from staging and persist')
		.action(async () => {
			// TODO: percentile_cont(0.99) on notional_usd_estimate over last 30d,
			// write to p99_thresholds, mark cold-start floor as superseded.
			console.error('Not yet implemented.');
			process.exit(1);
		});

	await program.parseAsync([...argv]);
}

void main(process.argv);
