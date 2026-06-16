// Shared "keyboard_arrow_down" style chevron used by every select trigger.
// The icon is 12px × ~7.4px centered inside a 24×24 box, matching the Figma
// system spec. Color inherits from `currentColor`.
export function ChevronDown({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={`pointer-events-none size-[24px] flex items-center justify-center ${className ?? ''}`}
		>
			<svg
				width="12"
				height="8"
				viewBox="0 0 12 8"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path
					d="M1 1.5L6 6.5L11 1.5"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}
