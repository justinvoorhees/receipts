/**
 * tradeValueGraph — Step 1 of trade decomposition: from the callTracer trace,
 * build per-address net USDC/WETH/native-ETH deltas (the value-flow graph).
 * Split out of decomposeTrade.ts (2026-07-21). Pure.
 */
import {
	collectTraceLogs,
	decodeTransferLogs,
	collectNativeEthDeltas,
	USDC,
	WETH,
	type TraceNode,
	type LogLike,
	type RawTransfer,
} from './tradeEndpoints.js';
import { WITHDRAWAL_TOPIC, DEPOSIT_TOPIC } from './tradeDecoders.js';

export function buildValueFlowGraph(trace: TraceNode): {
	logs: LogLike[];
	transfers: RawTransfer[];
	addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }>;
} {
	const logs = collectTraceLogs(trace);
	const transfers = decodeTransferLogs(logs);
	const nativeEthDeltas = collectNativeEthDeltas(trace);

	// Per-address net deltas for USDC and WETH (in human units)
	const addrDeltas = new Map<string, { usdc: number; weth: number; nativeEth: number }>();

	const getOrInit = (addr: string) => {
		const k = addr.toLowerCase();
		if (!addrDeltas.has(k)) addrDeltas.set(k, { usdc: 0, weth: 0, nativeEth: 0 });
		return addrDeltas.get(k)!;
	};

	for (const t of transfers) {
		const token = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		const humanVal = token === USDC
			? Number(t.value) / 1e6
			: token === WETH
				? Number(t.value) / 1e18
				: 0;
		if (humanVal === 0) continue;

		const fromD = getOrInit(fromLower);
		const toD = getOrInit(toLower);
		if (token === USDC) {
			fromD.usdc -= humanVal;
			toD.usdc += humanVal;
		} else if (token === WETH) {
			fromD.weth -= humanVal;
			toD.weth += humanVal;
		}
	}

	// WETH wrap/unwrap events affect per-address WETH balances:
	// Withdrawal(src) = src burns WETH (decreases WETH balance, gets native ETH)
	// Deposit(dst) = dst mints WETH (increases WETH balance, sends native ETH)
	// Without this, intermediaries that unwrap WETH appear to "retain" it.
	for (const log of logs) {
		if (log.address.toLowerCase() !== WETH || !log.topics || log.topics.length < 2) continue;
		const topic0 = log.topics[0]!;
		if (topic0 === WITHDRAWAL_TOPIC) {
			const src = ('0x' + log.topics[1]!.slice(26)).toLowerCase();
			const amount = Number(BigInt(log.data)) / 1e18;
			const d = getOrInit(src);
			d.weth -= amount; // WETH burned
		} else if (topic0 === DEPOSIT_TOPIC) {
			const dst = ('0x' + log.topics[1]!.slice(26)).toLowerCase();
			const amount = Number(BigInt(log.data)) / 1e18;
			const d = getOrInit(dst);
			d.weth += amount; // WETH minted
		}
	}

	// Native ETH deltas
	for (const [addr, raw] of nativeEthDeltas) {
		const d = getOrInit(addr);
		d.nativeEth = Number(raw) / 1e18;
	}

	return { logs, transfers, addrDeltas };
}
