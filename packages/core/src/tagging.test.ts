import { describe, it, expect } from 'vitest';
import { labelAddress } from './tagging.js';

describe('labelAddress', () => {
	it('names a known fee sink', () => {
		// Real Velora fee vault, lifted from the old selectionGate.ts FEE_VAULTS set.
		const r = labelAddress('0x00700052c0608f670705380a4900e0a8080010cc');
		expect(r.kind).toBe('fee-sink');
		expect(r.label).toBe('Velora Fee Vault');
	});

	it('names the other known fee sink (Relay)', () => {
		const r = labelAddress('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		expect(r.kind).toBe('fee-sink');
		expect(r.label).toBe('Relay Fee Vault');
	});

	it('is case-insensitive', () => {
		const r = labelAddress('0x00700052C0608F670705380A4900E0A8080010CC');
		expect(r.kind).toBe('fee-sink');
		expect(r.label).toBe('Velora Fee Vault');
	});

	it('names a known router from routerRegistry', () => {
		// Odos V2 router, from configs/routers.json (also mirrored in routerRegistry test fixtures).
		const r = labelAddress('0x19ceead7105607cd444f5ad10dd51356436095a1');
		expect(r.kind).toBe('router');
		expect(r.label).toBe('Odos');
	});

	it('passes unknown addresses through as raw', () => {
		const r = labelAddress('0xdeadbeef');
		expect(r.kind).toBe('unknown');
		expect(r.label).toBe('0xdeadbeef');
	});
});
