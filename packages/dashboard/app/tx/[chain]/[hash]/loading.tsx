/**
 * Shown while the server render analyzes the transaction — roughly 40 RPC calls,
 * so this is seconds, not milliseconds. Without it the browser sits on the old
 * page with no feedback: the search box's own spinner covers a client-side
 * navigation that has already handed off.
 */
export default function Loading() {
	return (
		<div className="mt-[40px] font-['Sohne_Mono'] text-[12px] leading-[18px]">
			Analyzing transaction…
		</div>
	);
}
