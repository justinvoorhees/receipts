/**
 * Recognising chat-app link expanders, and answering them cheaply.
 *
 * GET /tx/<chain>/<hash> runs a full ~130-call analysis in its render path.
 * A link expander wants four things — title, description, image, site name —
 * all of which live in <head>, and it discards the rest. So every preview of a
 * shared receipt costs a complete analysis to produce a few hundred bytes the
 * fetcher will read and throw away.
 *
 * That is the defect this module addresses. It is not "bots visit us"; it is
 * that we had no way to answer cheaply.
 *
 * ⚠️ robots.txt does NOT stop these. Measured 2026-08-11: Slack fetched a
 * receipt URL to build a preview despite `Disallow: /tx/` being served
 * correctly. Expanders are widely not crawlers and largely ignore it.
 *
 * Kept pure and free of Next imports — same reason as receiptUrl.ts — so the
 * matcher and the markup are testable without standing up a request. The Next
 * wrapper is middleware.ts and holds no logic.
 */

/**
 * User-agent substrings that identify a link expander.
 *
 * ⚠️ Matched as substrings ANYWHERE in the UA, which iMessage requires: Apple's
 * fetcher appends `facebookexternalhit/1.1 Facebot Twitterbot/1.0` to an
 * otherwise ordinary Safari UA, so an anchored match would miss it entirely.
 *
 * ⚠️ Every token here must be one that CANNOT appear in a real browser's UA.
 * The two failure directions are not symmetric: missing an expander costs one
 * analysis, while matching a browser serves a person a stub page where their
 * receipt should be. When in doubt, leave it out.
 *
 * Search crawlers are deliberately absent. Googlebot and Bingbot honour the
 * robots.txt Disallow on /tx/, so they are not the traffic this exists to stop,
 * and serving a crawler something different from what a person sees is cloaking.
 *
 * ⚠️ This list is a snapshot of what these services sent as of 2026-08-11 and
 * WILL drift. It is a cost optimisation, never a security control — nothing may
 * depend on it being complete or on a match being trustworthy. A UA is
 * self-reported and trivially forged; the only thing forging one buys you here
 * is a cheaper response.
 */
const EXPANDER_TOKENS = [
	'slackbot',
	'facebookexternalhit',
	'facebot',
	'twitterbot',
	'discordbot',
	'telegrambot',
	'whatsapp',
	'linkedinbot',
	'skypeuripreview',
	'redditbot',
	'embedly',
	'pinterest',
	'tumblr',
	'vkshare',
	'nuzzel',
	'bitlybot',
	'quora link preview',
	'applebot-extended',
];

/**
 * Whether this user-agent belongs to a link expander.
 *
 * A missing or empty UA returns false — deliberately the permissive direction.
 * Absent UAs come from scripts and plain HTTP clients, including
 * scripts/smokeDeploy.mjs, whose receipt check exists to prove a real analysis
 * renders. Short-circuiting an empty UA would make that check pass having
 * verified nothing.
 */
export function isLinkExpander(userAgent: string | null | undefined): boolean {
	if (!userAgent) return false;
	const ua = userAgent.toLowerCase();
	return EXPANDER_TOKENS.some((token) => ua.includes(token));
}

/**
 * The stub served to an expander: everything a preview reads, and no analysis.
 *
 * ⚠️ It asserts NOTHING about the transaction, and that is a correctness
 * requirement rather than a stylistic one. No decode has run, so the pair, the
 * venue, the cost and even whether this hash is a swap at all are unknown here.
 * Every other empty state in this app is careful to describe only what the
 * analysis established (see CeilingNotice: "a refusal is a statement about US,
 * not about the transaction"). A preview that ran no analysis must describe
 * nothing at all — a stub reading "swap" or naming a pair would be a confident
 * claim about a transaction nobody looked at.
 *
 * `hash` MUST already be validated against HASH_RE by the caller. It is
 * interpolated into markup, and the validation is what makes that safe: the
 * regex admits only `0x` plus hex, so there is no character left that could
 * close an attribute or open a tag. Passing an unvalidated path segment here
 * would be an injection.
 */
export function previewHtml({ url, hash }: { url: string; hash: string }): string {
	// Same truncation the /qa table uses, so a hash reads the same wherever it
	// appears in short form.
	const short = `${hash.slice(0, 10)}…`;
	const title = `Receipt ${short}`;
	// Describes the TOOL, not this transaction. The site-wide description in
	// layout.tsx says "aggregator-routed swaps", which is fine on the index and
	// wrong here: attached to one hash it reads as a claim that THIS transaction
	// is an aggregator-routed swap, which is exactly what has not been checked.
	const description = 'Onchain transaction cost analysis.';

	// No <script>, no inline styles beyond a plain attribute: this has to satisfy
	// the same CSP as every other page, and there is nothing here worth scripting.
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Receipts">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="robots" content="noindex, nofollow">
</head>
<body>
<p>${title}</p>
<p><a href="${url}">Open the receipt</a> to run the analysis.</p>
</body>
</html>
`;
}
