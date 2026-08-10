import { Divider } from '../../components/receipt/receiptRows';

export const metadata = {
	title: 'Methodology - Receipts',
};

// Transcribed verbatim from Figma 662-4349 (desktop) / 667-4628 (mobile), except the
// Oracle Reference tolerance figure — kept at 50bps to match the real
// MANIPULATION_TOL_BPS constant in packages/core/src/benchmarkPrice.ts rather than
// Figma's "10 bps", which doesn't match any real constant. Prose only — no data
// access. Every block in a section is 20px apart; the page's outer rhythm is 40px.
function Heading({ children }: { children: React.ReactNode }) {
	return (
		<h2
			className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{children}
		</h2>
	);
}

function Label({ children }: { children: React.ReactNode }) {
	return <p className="text-[12px] leading-[12px] font-medium uppercase">{children}</p>;
}

function Body({ children }: { children: React.ReactNode }) {
	return <p className="text-[12px] leading-[20px]">{children}</p>;
}

export default function MethodologyPage() {
	// Sohne Mono is the page's base family (Figma 662-4353): the disclaimer, the
	// version tag, every Label and every Body is Söhne Mono. Only the headings
	// break out of it, and each sets Sohne Breit explicitly.
	return (
		<div className="mt-[40px] flex flex-col gap-[40px] font-['Sohne_Mono']">
			<Divider />

			<div className="flex flex-col gap-[20px]">
				<div className="flex flex-col gap-[12px]">
					{/* Halbfett (600), a step heavier than the Kräftig (500) section
					    headings below — Figma 662-4358. */}
					<h1
						className="font-['Sohne_Breit'] font-semibold text-[28px] leading-[28px]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						Methodology
					</h1>
					<p className="text-[12px] leading-[12px] text-[var(--color-secondary)]">v0.1</p>
				</div>
				<Body>
					Important: All pricing is provided on a best-effort basis and is not guaranteed. Market
					prices may be manipulated, skewed, stale, or unavailable. Receipts are provided for
					informational purposes only and do not constitute financial advice.
				</Body>
				<Body>All prices are measured at the block immediately before the transaction.</Body>
			</div>

			<Divider />

			<div className="flex flex-col gap-[20px]">
				<Heading>Market Price</Heading>

				<Label>WETH/USDC Price:</Label>
				<Body>
					The median price from three designated WETH/USDC liquidity pools, cross-referenced against
					an oracle reference. Used directly for WETH/USDC transactions or as a reference when pricing
					other token pairs and gas cost.
				</Body>

				<Body>All other prices may use up to three methods:</Body>

				<Label>Direct-Pool Price:</Label>
				<Body>
					The midpoint price from the deepest qualifying liquidity pool that trades the input and
					output tokens directly.
				</Body>

				<Label>WETH-Derived Price:</Label>
				<Body>
					The implied price linking the input and output tokens together through WETH. It is
					calculated from the midpoint price of the deepest qualifying token/WETH pool for each
					applicable token, cross-referenced against the WETH/USDC price method. For example,
					AAA/WETH and WETH/BBB can be combined to derive an AAA/BBB price. Used to corroborate a
					direct-pool price, or provide a fallback when no direct-pool price is available.
				</Body>

				<Label>Oracle Reference:</Label>
				<Body>
					An independent reference price calculated from external price feeds (Chainlink) for the
					input and output tokens. Used to corroborate liquidity-based prices within a tolerance of
					50 bps, or 0.50%. Oracle reference is never used to calculate Market Price.
				</Body>

				<Body>
					When at least 2/3 methods agree, prices are Verified. When only the direct-pool method or
					WETH-derived method are available, prices are Estimated. When neither, prices are
					Unavailable.
				</Body>
			</div>

			<div className="flex flex-col gap-[20px]">
				<Heading>Per-Leg Price</Heading>
				<Body>
					The midpoint price from the leg’s executing liquidity pool. When unavailable, the deepest
					qualifying liquidity pool for the same token pair is used as a fallback. Market maker legs
					remain unpriced by nature.
				</Body>
			</div>

			<Divider />
		</div>
	);
}
