// Load the monorepo-root .env into process.env before Next reads its config.
// We keep one .env at the project root rather than duplicating secrets per
// package — Next normally only looks for .env in this package's directory,
// so we point dotenv at ../../.env explicitly.
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '.env') });

/** @type {import('next').NextConfig} */
const config = {
	experimental: { typedRoutes: true },
	transpilePackages: ['@fabric-tca/db', '@fabric-tca/core'],
	// Allow ngrok-tunneled requests to the dev server. Without this, Next 15 logs
	// a cross-origin warning and may block HMR / static assets when the host
	// header is `*.ngrok-free.app` instead of localhost.
	allowedDevOrigins: ['*.ngrok-free.app', '*.ngrok-free.dev', '*.ngrok.app', '*.ngrok.io'],
	// Next.js 15.5.x has a devtools bug where segment-explorer-node.js#SegmentViewNode
	// is not found in the React Client Manifest, crashing the webpack module system.
	devIndicators: false,
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
