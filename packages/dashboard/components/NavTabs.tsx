'use client';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Placeholder tab set for v2. Rename / extend during dashboard design — the
// shape (label + href + matches) carried over from v1 unchanged.
const TABS: { label: string; href: Route; matches: (path: string) => boolean }[] = [
	{ label: 'Dashboard', href: '/' as Route, matches: (p) => p === '/' },
	{
		label: 'Trades',
		href: '/trades' as Route,
		matches: (p) => p === '/trades' || p.startsWith('/trades/'),
	},
];

export function NavTabs() {
	const pathname = usePathname() ?? '/';
	return (
		<nav className="flex gap-[40px] items-center">
			{TABS.map((tab) => {
				const selected = tab.matches(pathname);
				/*
				 * State styles (all share the `tab-underline` rules — offset, position,
				 * thickness, skip-ink — defined in globals.css):
				 *   enabled  → secondary, no underline
				 *   hover    → secondary, solid underline
				 *   pressed  → quaternary, solid underline (active mouse-down)
				 *   selected → primary, dotted underline (current route)
				 */
				const className = selected
					? 'text-[var(--color-primary)] underline decoration-dotted'
					: [
							'text-[var(--color-secondary)]',
							'hover:underline hover:decoration-solid',
							'active:text-[var(--color-quaternary)]',
						].join(' ');
				return (
					<Link
						key={tab.href}
						href={tab.href}
						className={`tab-underline font-['Sohne_Breit'] text-[16px] leading-[16px] ${className}`}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}
