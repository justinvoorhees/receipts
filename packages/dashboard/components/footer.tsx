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
		<footer className="max-w-[720px] mx-auto mt-[40px] px-5 md:px-0 pb-[40px] flex items-start md:items-center justify-between font-['Sohne_Breit'] text-[12px] leading-[12px]">
			<p>
				Built by{' '}
				<a href="https://withfabric.xyz" className="underline">
					Fabric
				</a>
				.
			</p>
			<nav className="flex flex-col items-end gap-[20px] md:flex-row md:items-center md:gap-[40px]">
				{LINKS.map((link) => (
					<a
						key={link.href}
						href={link.href}
						target="_blank"
						rel="noreferrer"
						className="text-[var(--color-secondary)] underline underline-offset-[3px] [text-decoration-skip-ink:none] hover:text-[var(--color-primary)]"
					>
						{link.label}
					</a>
				))}
			</nav>
		</footer>
	);
}
