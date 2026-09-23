import type { ReactNode } from 'react';
import { Header } from '../components/header';
import { Footer } from '../components/footer';
import '../styles/globals.css';

export const metadata = {
	title: 'Justin Voorhees',
	description: 'Transaction cost analysis for aggregator-routed swaps on Base.',
	openGraph: {
		type: 'website',
		title: 'Receipts',
		url: 'https://receipts.withfabric.xyz',
		description: 'Transaction cost analysis for aggregator-routed swaps on Base.',
		images: ['https://receipts.withfabric.xyz/og.jpg'],
	},
	twitter: {
		card: 'summary_large_image',
		images: ['https://receipts.withfabric.xyz/og.jpg'],
	},
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<Header />
				<main className="max-w-[720px] mx-auto px-5 md:px-0">{children}</main>
				<Footer />
			</body>
		</html>
	);
}
