import { ThemePicker } from './ThemePicker';

// Native aspect ratio of the RECEIPTS wordmark is 179.964:40 (~4.499).
// At 40px tall the rendered width is 179.964px.
const LOGO_HEIGHT = 40;
const LOGO_WIDTH = (LOGO_HEIGHT * 179.964) / 40;

export function Header() {
	return (
		<header className="flex items-center max-w-[720px] mx-auto px-5 md:px-0 pt-20">
			<a href="/" aria-label="Receipts — home" className="text-[var(--color-primary)]">
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
						WebkitMaskImage: 'url(/receipts-logo.svg)',
						WebkitMaskRepeat: 'no-repeat',
						WebkitMaskSize: 'contain',
						maskImage: 'url(/receipts-logo.svg)',
						maskRepeat: 'no-repeat',
						maskSize: 'contain',
					}}
				/>
			</a>
			<div className="ml-auto flex items-center">
				<ThemePicker />
			</div>
		</header>
	);
}
