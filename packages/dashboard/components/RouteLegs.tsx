'use client';
import type { RouteLeg } from '../lib/queries';

/** Well-known Base token addresses mapped to short symbols. */
const TOKEN_SYMBOLS: Record<string, string> = {
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
	'0x4200000000000000000000000000000000000006': 'WETH',
	'0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
};

function tokenSymbol(address: string): string {
	return TOKEN_SYMBOLS[address.toLowerCase()] ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatLegBps(bps: number | null): string {
	if (bps === null) return '—';
	return `${bps.toFixed(1)}bps`;
}

export function RouteLegs({
	legs,
	reconResidualBps,
}: {
	legs: RouteLeg[];
	reconResidualBps?: string | null | undefined;
}) {
	return (
		<div
			className="pl-[88px] pb-[8px] font-['Sohne_Mono'] text-[11px] leading-[18px] text-[var(--color-secondary)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{legs.map((leg, i) => (
				<div key={i} className="flex items-baseline gap-[12px]">
					<span className="w-[16px] text-right">{i + 1}.</span>
					<span className="w-[80px]">{leg.type}</span>
					<span className="w-[140px]">
						{tokenSymbol(leg.tokenIn)} {'→'} {tokenSymbol(leg.tokenOut)}
					</span>
					<span className="w-[64px] text-right">{leg.feeTierBps}bps fee</span>
					<span className="w-[80px] text-right">
						impact {formatLegBps(leg.priceImpactBps)}
					</span>
				</div>
			))}
			{reconResidualBps != null && (
				<div className="mt-[2px] text-[var(--color-secondary)] opacity-60">
					recon residual: {Number(reconResidualBps).toFixed(1)}bps
				</div>
			)}
		</div>
	);
}
