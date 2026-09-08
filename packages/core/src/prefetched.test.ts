import { describe, expect, it } from 'vitest';
import { fromSeedJson } from './prefetched.js';

const RECEIPT_JSON = JSON.stringify({
	blockNumber: '0x307cc2f',
	gasUsed: '0x5208',
	effectiveGasPrice: '0x3b9aca00',
	logs: [
		{ address: '0xAAA', topics: ['0x11', '0x22'], data: '0x' },
		{ address: '0xbbb', topics: ['0x33'], data: '0x' },
	],
});
const TX_JSON = JSON.stringify({ from: '0xFROM', to: '0xTO', value: '0x0' });
const TRACE_JSON = JSON.stringify({ type: 'CALL', from: '0xa', to: '0xb', calls: [] });

describe('fromSeedJson', () => {
	it('parses hex quantities into the bigints the decoder expects', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.receipt.blockNumber).toBe(50842671n);
		expect(p.receipt.gasUsed).toBe(21000n);
		expect(p.receipt.effectiveGasPrice).toBe(1000000000n);
	});

	it('preserves log order, address and topics', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.receipt.logs).toHaveLength(2);
		expect(p.receipt.logs[0]!.address).toBe('0xAAA');
		expect(p.receipt.logs[0]!.topics).toEqual(['0x11', '0x22']);
		expect(p.receipt.logs[1]!.topics).toEqual(['0x33']);
	});

	it('passes tx.from and tx.to through untouched', () => {
		// Casing is NOT normalized here: every consumer lowercases at its own
		// call site, and normalizing early would diverge from what viem returns.
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.tx.from).toBe('0xFROM');
		expect(p.tx.to).toBe('0xTO');
	});

	it('yields null for a contract-creation tx.to', () => {
		const p = fromSeedJson({
			receiptJson: RECEIPT_JSON,
			txJson: JSON.stringify({ from: '0xa', to: null }),
			traceJson: TRACE_JSON,
		});
		expect(p.tx.to).toBeNull();
	});

	it('yields undefined effectiveGasPrice when the receipt omits it', () => {
		// Absent must not become 0n: gasCostUsd multiplies by it, and 0 would
		// silently report a free transaction.
		const p = fromSeedJson({
			receiptJson: JSON.stringify({ blockNumber: '0x1', gasUsed: '0x1', logs: [] }),
			txJson: TX_JSON,
			traceJson: TRACE_JSON,
		});
		expect(p.receipt.effectiveGasPrice).toBeUndefined();
	});

	it('parses the trace with no transformation at all', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.trace).toEqual(JSON.parse(TRACE_JSON));
	});

	it('refuses a receipt missing blockNumber rather than yielding NaN', () => {
		expect(() =>
			fromSeedJson({
				receiptJson: JSON.stringify({ gasUsed: '0x1', logs: [] }),
				txJson: TX_JSON,
				traceJson: TRACE_JSON,
			}),
		).toThrow(/blockNumber/);
	});

	it('refuses malformed JSON with a message naming which payload', () => {
		expect(() =>
			fromSeedJson({ receiptJson: 'not json', txJson: TX_JSON, traceJson: TRACE_JSON }),
		).toThrow(/receipt/i);
	});
});
