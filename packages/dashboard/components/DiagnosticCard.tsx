import type { AnalyzeFailure, FailureReason } from '@fabric-tca/core';
import { shortTxHash } from '../lib/formatters';

export const REASON_COPY: Record<FailureReason, { title: string; body: string }> = {
	INVALID_HASH: {
		title: 'Invalid transaction hash',
		body: 'That doesn’t look like a transaction hash — expected a 66-character 0x… value.',
	},
	NOT_FOUND_ONCHAIN: {
		title: 'Not found on Base',
		body: 'No transaction with this hash exists on Base (chain 8453). Check the hash and that it’s a Base transaction.',
	},
	RELAYER_THIRD_PARTY: {
		title: 'Relay / third-party trade',
		body: 'The sender relayed this swap on behalf of another address. Beneficiary-anchored decoding isn’t supported yet.',
	},
	NOT_DECODABLE: {
		title: 'Not a decodable swap',
		body: 'We couldn’t find a clean token-in / token-out swap for the sender. It may be a transfer, approval, LP action, or a multi-hop batch we don’t decompose yet.',
	},
	ANALYZE_ERROR: {
		title: 'Couldn’t analyze',
		body: 'Couldn’t analyze this transaction — try again.',
	},
};

export function DiagnosticCard({ failure }: { failure: AnalyzeFailure }) {
	const copy = REASON_COPY[failure.reason];
	const d = failure.detail;
	const pair =
		d && (d.inputSymbol || d.outputSymbol)
			? `${d.inputSymbol ?? shortTxHash(d.inputToken)} → ${d.outputSymbol ?? shortTxHash(d.outputToken)}`
			: null;

	return (
		<div
			className="flex flex-col gap-[12px] rounded-[2px] border p-[20px]"
			style={{ borderColor: 'var(--color-red)' }}
		>
			<span className="font-['Sohne_Breit'] text-[14px] leading-[16px]" style={{ color: 'var(--color-red)' }}>
				{copy.title}
			</span>
			<span className="font-['Sohne'] text-[13px] leading-[18px]" style={{ color: 'var(--color-secondary)' }}>
				{copy.body}
			</span>
			{failure.reason === 'RELAYER_THIRD_PARTY' && d && (
				<div className="flex flex-col gap-[4px] font-['Sohne_Mono'] text-[12px] leading-[16px]">
					<span style={{ color: 'var(--color-secondary)' }}>
						Swap executed for{' '}
						<span style={{ color: 'var(--color-primary)' }}>{shortTxHash(d.beneficiary)}</span>
					</span>
					{pair && <span style={{ color: 'var(--color-primary)' }}>{pair}</span>}
				</div>
			)}
		</div>
	);
}
