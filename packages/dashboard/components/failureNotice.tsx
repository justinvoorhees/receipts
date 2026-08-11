import { TooltipTrigger } from './receipt/receiptRows';
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
		tooltip: null,
	},
	CROSS_CHAIN_LEG: {
		label: 'Cross-chain transactions not supported',
		tooltip: null,
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
		<TooltipTrigger
			tooltip={tooltip}
			align="left"
			className="w-fit cursor-default font-['Sohne_Breit'] text-[12px] leading-[12px] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
			style={{ color: 'var(--color-red)' }}
			bubbleClassName="font-['Sohne_Mono'] no-underline"
		>
			{label}
		</TooltipTrigger>
	);
}
