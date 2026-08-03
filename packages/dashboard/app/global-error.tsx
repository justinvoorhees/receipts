'use client';

/**
 * Last-resort boundary for errors thrown by the root layout itself.
 *
 * It replaces the whole document, so it must render its own <html>/<body> and
 * cannot rely on the layout's fonts, theme tokens or styles — hence the inline
 * system-font styling rather than the app's classes.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
	return (
		<html lang="en">
			<body style={{ margin: 0, padding: '80px 24px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
				<h1 style={{ fontSize: 12, margin: '0 0 20px' }}>Application error</h1>
				<p style={{ margin: 0, opacity: 0.7 }}>{error.message || error.digest || 'Unknown error.'}</p>
			</body>
		</html>
	);
}
