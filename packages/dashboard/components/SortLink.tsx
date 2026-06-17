'use client';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Client-side sortable header link. Wraps `router.push` in a transition so
 * the click registers visually (dim/pulse the link) the instant it's made,
 * even while the server re-renders the page in the background. Without this
 * a slow server-component render makes the click feel ignored — users
 * click repeatedly thinking nothing's happening.
 *
 * URL state is the source of truth — this component reads its current state
 * from useSearchParams and writes back via router.push.
 */
export function SortLink({
	col,
	pathname,
	className,
	children,
}: {
	col: string;
	pathname: string;
	className?: string;
	children: React.ReactNode;
}) {
	const router = useRouter();
	const params = useSearchParams();
	const [pending, startTransition] = useTransition();

	const currentCol = params.get('sort') ?? 'time';
	const currentDir = params.get('dir') ?? 'desc';
	const active = currentCol === col;
	const nextDir = active && currentDir === 'desc' ? 'asc' : 'desc';
	const arrow = active ? (currentDir === 'desc' ? ' ↓' : ' ↑') : '';

	const href = `${pathname}?sort=${col}&dir=${nextDir}`;
	const onClick = (e: React.MouseEvent) => {
		e.preventDefault();
		startTransition(() => {
			router.push(href as Route);
		});
	};

	return (
		<a
			href={href}
			onClick={onClick}
			className={`underline decoration-dotted underline-offset-[2px] whitespace-nowrap transition-opacity ${
				active ? 'text-[var(--color-primary)]' : ''
			} ${pending ? 'opacity-50' : ''} ${className ?? ''}`}
		>
			{children}
			{arrow}
		</a>
	);
}
