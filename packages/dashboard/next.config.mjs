/** @type {import('next').NextConfig} */
const config = {
	experimental: { typedRoutes: true },
	transpilePackages: ['@fabric-tca/core', '@fabric-tca/db', '@fabric-tca/analytics'],
	// Allow ngrok-tunneled requests to the dev server. Without this, Next 15 logs
	// a cross-origin warning and may block HMR / static assets when the host
	// header is `*.ngrok-free.app` instead of localhost.
	allowedDevOrigins: ['*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io'],
};
export default config;
