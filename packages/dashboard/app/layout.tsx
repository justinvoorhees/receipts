import type { ReactNode } from 'react';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import '../styles/globals.css';

export const metadata = {
	title: 'Fabric TCA',
	description: 'Transaction cost analysis for aggregator-routed swaps on Base.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<Header />
				<hr className="border-0 border-t border-[var(--color-primary)] max-w-[720px] mx-auto mt-[40px]" />
				<main className="max-w-[720px] mx-auto">{children}</main>
				<Footer />
			</body>
		</html>
	);
}
