/**
 * The four segmented filter dropdowns from the dashboard header (time /
 * chain / pair / size). Rendered as static placeholders for now — the
 * surfaces are in place but no filter state is wired through to queries
 * yet. Wire them as the data slicing requirements firm up.
 */

const FILTERS = [
	{ label: 'All Time', edge: 'left' },
	{ label: 'All Chains', edge: 'mid' },
	{ label: 'All Pairs', edge: 'mid' },
	{ label: 'All Sizes', edge: 'right' },
] as const;

export function FilterRow() {
	return (
		<div className="mt-[14px] flex items-center w-full">
			{FILTERS.map((f, i) => (
				<FilterCell key={f.label} label={f.label} edge={f.edge} isFirst={i === 0} />
			))}
		</div>
	);
}

function FilterCell({
	label,
	edge,
	isFirst,
}: {
	label: string;
	edge: 'left' | 'mid' | 'right';
	isFirst: boolean;
}) {
	const radius =
		edge === 'left'
			? 'rounded-l-[2px]'
			: edge === 'right'
				? 'rounded-r-[2px]'
				: '';
	// Borders: every cell carries top + bottom + right. The first cell adds
	// its own left border. This gives shared edges with no double-thickness.
	const border = [
		'border-t border-b border-r border-[var(--color-primary)]',
		isFirst ? 'border-l' : '',
	].join(' ');
	return (
		<button
			type="button"
			disabled
			className={`flex-1 flex items-center justify-between pl-[12px] pr-[8px] py-[8px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-primary)] ${border} ${radius} cursor-not-allowed`}
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			<span>{label}</span>
			<ChevronDown />
		</button>
	);
}

function ChevronDown() {
	return (
		<svg
			width="12"
			height="8"
			viewBox="0 0 12 8"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
		>
			<path
				d="M1 1L6 6L11 1"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinecap="square"
			/>
		</svg>
	);
}
