import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL = process.env.LOG_LEVEL;
afterEach(() => { process.env.LOG_LEVEL = ORIGINAL; vi.restoreAllMocks(); });

async function freshLogger() {
	vi.resetModules();
	return (await import('./log.js')).log;
}

describe('log', () => {
	beforeEach(() => vi.clearAllMocks());

	it('emits one line of parseable JSON', async () => {
		process.env.LOG_LEVEL = 'info';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		(await freshLogger()).info('receipt computed', { hash: '0xabc', ms: 812 });

		const written = out.mock.calls[0]![0] as string;
		expect(written.endsWith('\n')).toBe(true);
		expect(written.trimEnd().includes('\n')).toBe(false);
		expect(JSON.parse(written)).toMatchObject({
			level: 'info', msg: 'receipt computed', hash: '0xabc', ms: 812,
		});
	});

	it('suppresses levels below the configured one', async () => {
		process.env.LOG_LEVEL = 'warn';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.debug('noisy');
		log.info('also noisy');
		expect(out).not.toHaveBeenCalled();
	});

	it('emits levels at or above the configured one', async () => {
		process.env.LOG_LEVEL = 'warn';
		const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.warn('heard');
		log.error('heard');
		expect(err).toHaveBeenCalledTimes(2);
	});

	// error/warn to stderr, everything else to stdout — so a log drain can split
	// them without parsing, and a crash dump keeps the two streams distinct.
	it('routes error and warn to stderr, the rest to stdout', async () => {
		process.env.LOG_LEVEL = 'trace';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
		expect(err).toHaveBeenCalledTimes(2);
		expect(out).toHaveBeenCalledTimes(3);
	});

	it('falls back to info on an unrecognised LOG_LEVEL', async () => {
		process.env.LOG_LEVEL = 'chatty';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.debug('suppressed');
		log.info('emitted');
		expect(out).toHaveBeenCalledTimes(1);
	});
});
