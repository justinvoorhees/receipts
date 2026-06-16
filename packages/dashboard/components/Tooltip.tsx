'use client';
import { useState, type ReactNode } from 'react';

export interface TooltipRow {
	label: string;
	value: ReactNode;
	failed?: boolean;
}

export function Tooltip({
	rows,
	children,
}: {
	rows: TooltipRow[];
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
	return (
		<g
			onMouseEnter={(e) => {
				setOpen(true);
				setCoords({ x: e.clientX, y: e.clientY });
			}}
			onMouseMove={(e) => setCoords({ x: e.clientX, y: e.clientY })}
			onMouseLeave={() => setOpen(false)}
		>
			{children}
			{open && coords && (
				<foreignObject x={0} y={0} width="100%" height="100%" pointerEvents="none">
					<div
						className="fixed bg-[var(--color-surface-base)] border border-[var(--color-primary)] px-3 py-2 rounded-[2px] font-['Sohne_Mono'] text-[12px] pointer-events-none z-50"
						style={{ left: coords.x + 12, top: coords.y + 12 }}
					>
						{rows.map((r) => (
							<div key={r.label} className="flex justify-between gap-6">
								<span className="text-[var(--color-secondary)] uppercase">{r.label}</span>
								<span className={r.failed ? 'text-[var(--color-red)]' : ''}>{r.value}</span>
							</div>
						))}
					</div>
				</foreignObject>
			)}
		</g>
	);
}
