import { Suspense } from 'react';
import { NavTabs } from './NavTabs';
import { ThemePicker } from './ThemePicker';
import { IngestStatus } from './IngestStatus';

// Native aspect ratio of the wordmark SVG is 512:139 (~3.683).
// At 40px tall the rendered width is 40 * 512/139 ≈ 147.4px.
const LOGO_HEIGHT = 40;
const LOGO_WIDTH = (LOGO_HEIGHT * 512) / 139;

export function Header() {
	return (
		<header className="flex items-center max-w-[1132px] mx-auto pt-20">
			<a href="/" aria-label="Fabric — home" className="text-[var(--color-primary)]">
				{/*
				 * The wordmark is rendered as a CSS mask so its color follows the parent's
				 * `currentColor`. That way the logo adopts the active theme's primary color
				 * (light, dark, blue, coffee, terminal) without shipping multiple SVG files.
				 */}
				<span
					aria-hidden="true"
					style={{
						display: 'block',
						height: LOGO_HEIGHT,
						width: LOGO_WIDTH,
						backgroundColor: 'currentColor',
						WebkitMaskImage: 'url(/fabric-logo-h-black.svg)',
						WebkitMaskRepeat: 'no-repeat',
						WebkitMaskSize: 'contain',
						maskImage: 'url(/fabric-logo-h-black.svg)',
						maskRepeat: 'no-repeat',
						maskSize: 'contain',
					}}
				/>
			</a>
			<div className="ml-auto flex items-center gap-[40px]">
				<Suspense fallback={null}>
					<IngestStatus />
				</Suspense>
				<NavTabs />
				<ThemePicker />
			</div>
		</header>
	);
}
