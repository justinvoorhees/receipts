import { describe, it, expect } from 'vitest';
import { isLinkExpander, previewHtml } from './linkExpander';

/**
 * Real user-agent strings, kept verbatim. A paraphrased UA proves nothing about
 * a matcher whose whole job is to recognise the real ones.
 */
const BROWSERS = [
	// Chrome, macOS
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	// Safari, iPhone
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	// Firefox, Windows
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
	// Edge, Windows
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];

const EXPANDERS = [
	'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
	'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
	// iMessage. Apple's fetcher borrows Facebook's and Twitter's tokens on the
	// end of an otherwise ordinary Safari UA — which is precisely why the matcher
	// must look for tokens ANYWHERE in the string rather than at the front.
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Safari/605.1.15 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
	'Twitterbot/1.0',
	'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
	'TelegramBot (like TwitterBot)',
	'WhatsApp/2.19.81 A',
	'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
	'Mozilla/5.0 (compatible; SkypeUriPreview Preview/0.5)',
	'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
	'Embedly/0.2 (+http://support.embed.ly/)',
];

describe('isLinkExpander', () => {
	it.each(EXPANDERS)('recognises %s', (ua) => {
		expect(isLinkExpander(ua)).toBe(true);
	});

	it.each(BROWSERS)('does not match the browser UA %s', (ua) => {
		// The expensive direction of a false positive: a person gets a stub page
		// where their receipt should be. Cheaper to miss a bot than to break a
		// human, and this list is what pins that preference.
		expect(isLinkExpander(ua)).toBe(false);
	});

	it('treats a missing user-agent as NOT an expander', () => {
		// Deliberately the permissive direction. An absent UA is what scripts and
		// some HTTP clients send — including scripts/smokeDeploy.mjs, whose whole
		// job is to verify that a REAL receipt renders. Short-circuiting an empty
		// UA would make that check pass while verifying nothing.
		expect(isLinkExpander(null)).toBe(false);
		expect(isLinkExpander('')).toBe(false);
	});

	it('matches regardless of case', () => {
		expect(isLinkExpander('slackbot-linkexpanding 1.0')).toBe(true);
		expect(isLinkExpander('SLACKBOT-LINKEXPANDING 1.0')).toBe(true);
	});

	it('does not match a search crawler', () => {
		// Deliberate exclusion, not an oversight. Googlebot and Bingbot honour the
		// robots.txt Disallow on /tx/, so they are not the traffic this exists to
		// stop — and serving crawlers something different from what a person sees
		// is cloaking, which is a rule worth not bending for no benefit.
		expect(isLinkExpander('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(false);
		expect(isLinkExpander('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')).toBe(false);
	});
});

describe('previewHtml', () => {
	const HASH = '0xe49e79a002acb21549efd50a181aafaa0e3adde9e807d3a3c71215992ecf662c';
	const URL_ = `https://receipts.withfabric.xyz/tx/base/${HASH}`;

	it('carries the OG tags an expander reads', () => {
		const html = previewHtml({ url: URL_, hash: HASH });
		expect(html).toContain('<meta property="og:title"');
		expect(html).toContain('<meta property="og:description"');
		expect(html).toContain(`<meta property="og:url" content="${URL_}"`);
		expect(html).toContain('<meta property="og:site_name"');
		expect(html).toContain('<meta name="twitter:card"');
	});

	it('identifies the transaction by its truncated hash', () => {
		const html = previewHtml({ url: URL_, hash: HASH });
		expect(html).toContain('0xe49e79a0…');
	});

	it('asserts NOTHING about the trade', () => {
		// The whole point is that we have not looked at this transaction. Every
		// other empty state in this app is careful to describe only what the
		// analysis established; a preview that ran no analysis must describe
		// nothing at all. A stub claiming "swap" or naming a pair or a cost would
		// be a confident statement about a transaction nobody decoded.
		const html = previewHtml({ url: URL_, hash: HASH }).toLowerCase();
		for (const claim of ['bps', 'slippage', 'aggregator', 'pool', '$', '→']) {
			expect(html).not.toContain(claim);
		}
	});

	it('links back so a person who lands here can still get the receipt', () => {
		expect(previewHtml({ url: URL_, hash: HASH })).toContain(`href="${URL_}"`);
	});

	it('contains no script tag, so it cannot trip the CSP or run anything', () => {
		expect(previewHtml({ url: URL_, hash: HASH })).not.toContain('<script');
	});
});
