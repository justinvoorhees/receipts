import type { AnalyzeFailure, FailureReason } from '@fabric-tca/core';

export const REASON_COPY: Record<FailureReason, { label: string; tooltip: string | null }> = {
	INVALID_HASH: {
		label: 'Invalid transaction hash',
		tooltip: 'Input is not a transaction hash, try a 66-character 0x... value',
	},
	NOT_FOUND_ONCHAIN: {
		label: 'Transaction not found on Base',
		tooltip: null,
	},
	RELAYER_THIRD_PARTY: {
		label: 'Transaction not supported',
		tooltip: 'Beneficiary-anchored decoding not yet supported (relayer, third-party, peer-to-peer, etc)',
	},
	NOT_DECODABLE: {
		label: 'Not a swap',
		tooltip: 'Token-in / token-out swap not found (signature, approval, LP action, etc)',
	},
	ANALYZE_ERROR: {
		label: 'Analysis failed, try again',
		tooltip: 'RPC error, unavailable trace, or other unexpected infrastructure error',
	},
};

/** Inline red reason label under the search field. Plain when tooltip is null;
 *  otherwise a dotted-underline (solid on hover) trigger with a dark tooltip above. */
export function FailureNotice({ failure }: { failure: AnalyzeFailure }) {
	const { label, tooltip } = REASON_COPY[failure.reason];

	if (!tooltip) {
		return (
			<span className="font-['Sohne_Breit'] text-[12px] leading-[12px]" style={{ color: 'var(--color-red)' }}>
				{label}
			</span>
		);
	}

	return (
		<span
			className="group relative w-fit cursor-default font-['Sohne_Breit'] text-[12px] leading-[12px] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
			style={{ color: 'var(--color-red)' }}
		>
			{label}
			<span className="pointer-events-none invisible absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] whitespace-normal rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left font-['Sohne_Mono'] text-[12px] font-normal leading-[20px] text-[var(--color-surface-base)] no-underline group-hover:visible">
				{tooltip}
			</span>
		</span>
	);
}
