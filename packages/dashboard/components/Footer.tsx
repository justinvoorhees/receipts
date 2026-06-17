export function Footer() {
	return (
		<footer className="border-t border-[var(--color-primary)] max-w-[1132px] mx-auto mt-10 py-20 flex items-center justify-between">
			<p className="font-['Sohne_Breit'] text-[12px]">
				Built by{' '}
				<a href="https://withfabric.xyz" className="underline">
					Fabric
				</a>
				. Powered by{' '}
				<a href="https://spandex.sh" className="underline">
					spanDEX
				</a>
				.
			</p>
		</footer>
	);
}
