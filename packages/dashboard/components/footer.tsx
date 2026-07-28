// The rule above the footer is rendered by each page, not by the footer itself:
// on the receipt page it sits above the SHARE bar, on /methodology directly
// above this row. A border-t here would double it.
const LINKS: { label: string; href: string }[] = [
	{ label: 'Docs', href: 'https://docs.withfabric.xyz/' },
	{ label: 'spanDEX', href: 'https://spandex.sh/' },
	{ label: 'Quotebench', href: 'https://benchmark.withfabric.xyz/' },
	{ label: 'Methodology', href: '/methodology' },
];

export function Footer() {
	return (
		<footer className="max-w-[720px] mx-auto mt-[40px] pb-[40px] flex items-center justify-between font-['Sohne_Breit'] text-[12px] leading-[12px]">
			<p>
				Built by{' '}
				<a href="https://withfabric.xyz" className="underline">
					Fabric
				</a>
				.
			</p>
			<nav className="flex items-center gap-[40px]">
				{LINKS.map((link) => (
					<a
						key={link.href}
						href={link.href}
						className="text-[var(--color-secondary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid hover:text-[var(--color-primary)]"
					>
						{link.label}
					</a>
				))}
			</nav>
		</footer>
	);
}
