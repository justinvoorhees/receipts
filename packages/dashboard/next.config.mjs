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
	transpilePackages: ['@fabric-tca/db'],
	// Allow ngrok-tunneled requests to the dev server. Without this, Next 15 logs
	// a cross-origin warning and may block HMR / static assets when the host
	// header is `*.ngrok-free.app` instead of localhost.
	allowedDevOrigins: ['*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io'],
};
export default config;
