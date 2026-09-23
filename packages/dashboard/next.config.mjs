// Load the monorepo-root .env into process.env before Next reads its config.
// We keep one .env at the project root rather than duplicating secrets per
// package — Next normally only looks for .env in this package's directory,
// so we point dotenv at ../../.env explicitly.
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noIndexHeaders, securityHeaders } from './lib/securityHeaders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '.env') });

/** @type {import('next').NextConfig} */
const config = {
	// Top-level since Next 15.5.20; it warns loudly under `experimental`.
	typedRoutes: true,
	// Linting is a separate concern (root `npm run lint`, using the monorepo's
	// eslint.config.js + typescript-eslint) — those aren't dashboard's own
	// dependencies, so Vercel's per-package install doesn't have them and the
	// production build shouldn't need them either.
	eslint: { ignoreDuringBuilds: true },
	transpilePackages: ['@fabric-tca/core'],
	// Allow ngrok-tunneled requests to the dev server. Without this, Next 15 logs
	// a cross-origin warning and may block HMR / static assets when the host
	// header is `*.ngrok-free.app` instead of localhost.
	allowedDevOrigins: ['*.ngrok-free.app', '*.ngrok-free.dev', '*.ngrok.app', '*.ngrok.io'],
	// Next.js 15.5.x has a devtools bug where segment-explorer-node.js#SegmentViewNode
	// is not found in the React Client Manifest, crashing the webpack module system.
	devIndicators: false,
	async headers() {
		return [
			{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production') },
			// Scoped to the RPC-spending routes only, so the index and
			// /methodology stay indexable. See noIndexHeaders' docblock.
			{ source: '/tx/:path*', headers: noIndexHeaders() },
			{ source: '/qa/:path*', headers: noIndexHeaders() },
		];
	},
	// @fabric-tca/core is consumed as TypeScript source (see transpilePackages) and
	// uses ESM `.js` import specifiers that actually resolve to `.ts` files (e.g.
	// `./analyzeTransaction.js` → `analyzeTransaction.ts`). Webpack does not do this
	// TS→JS extension mapping by default, so teach its resolver to try `.ts`/`.tsx`
	// before `.js`. This also covers the dashboard's own `.js`-suffixed imports.
	webpack: (webpackConfig) => {
		webpackConfig.resolve.extensionAlias = {
			'.js': ['.ts', '.tsx', '.js'],
			'.jsx': ['.tsx', '.jsx'],
		};
		return webpackConfig;
	},
};
export default config;
