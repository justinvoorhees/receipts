import { unstable_noStore as noStore } from 'next/cache';
import { getHeartbeats } from '../lib/queries';

/**
 * Inline liveness indicator for the two ingest services. Reads
 * `ingest_heartbeats` and shows a dot + relative-time pill per service.
 * Server-rendered with noStore so it reflects DB state at render time —
 * caching would defeat the purpose.
 *
 * Tone is purely a function of staleness against `STALE_AFTER_S`. A
 * service that reported `last_status='error'` recently still renders as
 * "fresh" with the error visible on hover, since the *signal* is fresh
 * even if the *content* is bad.
 */

const STALE_AFTER_S = 30;
const DOWN_AFTER_S = 300; // 5 min

export async function IngestStatus() {
	noStore();
	const beats = await getHeartbeats();
	const byService = new Map(beats.map((b) => [b.service, b]));
	return (
		<div className="flex items-center gap-[16px] font-['Sohne_Mono'] text-[10px] uppercase tracking-wide">
			<ServicePill name="poll" beat={byService.get('poller')} />
			<ServicePill name="promote" beat={byService.get('promoter')} />
		</div>
	);
}

function ServicePill({
	name,
	beat,
}: {
	name: string;
	beat:
		| { lastTickAt: Date; lastStatus: string; lastError: string | null }
		| undefined;
}) {
	if (!beat) {
		return <Pill dotColor="var(--color-tertiary)" label={`${name} • never`} />;
	}
	const ageSec = Math.floor((Date.now() - beat.lastTickAt.getTime()) / 1000);
	const tone =
		ageSec > DOWN_AFTER_S
			? 'var(--color-fabric-red, #c44)'
			: ageSec > STALE_AFTER_S
				? 'var(--color-fabric-yellow, #c93)'
				: beat.lastStatus === 'error'
					? 'var(--color-fabric-yellow, #c93)'
					: 'var(--color-fabric-green, #3a7)';
	const title = beat.lastError ? `last error: ${beat.lastError}` : `last tick: ${beat.lastTickAt.toISOString()}`;
	return <Pill dotColor={tone} label={`${name} • ${formatAge(ageSec)}`} title={title} />;
}

function Pill({
	dotColor,
	label,
	title,
}: {
	dotColor: string;
	label: string;
	title?: string;
}) {
	return (
		<span
			className="flex items-center gap-[6px] text-[var(--color-secondary)]"
			title={title ?? ''}
		>
			<span
				aria-hidden="true"
				style={{
					display: 'inline-block',
					width: 6,
					height: 6,
					borderRadius: 9999,
					backgroundColor: dotColor,
				}}
			/>
			{label}
		</span>
	);
}

function formatAge(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}
