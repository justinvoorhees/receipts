/**
 * smokeDeploy.mjs — verify a deployed instance behaves the way it does locally.
 *
 * Checks a running deployment: that the public receipt path renders, that a
 * malformed hash 404s cheaply instead of spending an analysis, that link
 * expanders get the cheap stub while browsers do not, that security headers are
 * in place, and — the check that matters most — that the dev-only /qa route is
 * unreachable in production. Nothing is stored on this service any more, so
 * there is no corpus to damage; the one real cost is the single fresh analysis
 * (~130 RPC calls) the receipt check triggers.
 *
 * That analysis also fires ACTIVITY_WEBHOOK_URL, so each run posts one message
 * to the activity channel.
 *
 *   node scripts/smokeDeploy.mjs https://receipts.withfabric.xyz
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
	console.error('usage: node scripts/smokeDeploy.mjs <base-url>');
	process.exit(2);
}

// A hash from the frozen corpus (docs/qa/corpus.json) — any known-good hash
// works, since receipts are computed on demand now and nothing is cached.
const KNOWN_HASH = '0xbdaa6662fa12410d329d8954e46ea611f8a3a2008426151cba1c37121edbc9ce';

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(path, init = {}) {
	try {
		const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
		return { status: res.status, headers: res.headers, body: await res.text() };
	} catch (e) {
		return { status: 0, headers: new Headers(), body: String(e.message) };
	}
}

console.log(`\nSmoke-testing ${base}\n`);

console.log('anonymous — should work:');
const home = await req('/');
check('GET /  serves the receipt tool', home.status === 200, `status ${home.status}`);
check('GET /methodology', (await req('/methodology')).status === 200);

// The receipt route computes on demand now; a known-good hash must render.
//
// Sent with an ordinary browser user-agent, deliberately. middleware.ts serves
// link expanders a cheap stub instead of running the analysis, so this doubles
// as the check that a PERSON is never mistaken for one — the expensive
// direction of that matcher being wrong. Reusing this request rather than
// adding a second browser-UA fetch keeps the script at one analysis.
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const receipt = await req(`/tx/base/${KNOWN_HASH}`, { headers: { 'user-agent': BROWSER_UA } });
check('GET /tx/base/<hash> renders a receipt', receipt.status === 200, `status ${receipt.status}`);
check('  …with the pair on the page', /→/.test(receipt.body));
check('  …and a browser is not mistaken for a link expander', !receipt.body.includes('Open the receipt'));

// A link expander must get the cheap stub, not a ~130-call analysis. Costs
// nothing to check — that is the entire point of the response being asserted.
const preview = await req(`/tx/base/${KNOWN_HASH}`, {
	headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
});
check(
	'a link expander gets the cheap preview, not an analysis',
	preview.status === 200 && preview.body.includes('Open the receipt'),
	`status ${preview.status}, ${preview.body.length} bytes`,
);
// Asserted against the REAL receipt fetched above rather than a fixed number:
// the point is that one response is an order of magnitude cheaper than the
// other, and a hardcoded byte threshold would drift with the page.
check(
	'  …and it is far smaller than the real receipt',
	preview.body.length * 10 < receipt.body.length,
	`${preview.body.length} vs ${receipt.body.length} bytes`,
);
console.log('\nsecurity headers:');
const csp = home.headers.get('content-security-policy') ?? '';
check('CSP is set', csp.length > 0);
check("CSP blocks framing", csp.includes("frame-ancestors 'none'"), csp.slice(0, 60));
// 'unsafe-eval' is a dev-only allowance; finding it here means a dev build shipped.
// Require a non-empty CSP too — otherwise a missing header makes this PASS
// having verified nothing (the "CSP is set" check above already fails in that
// case, so the exit code stays non-zero, but a PASS here reads as confirmation).
check("CSP has no 'unsafe-eval'", csp.length > 0 && !csp.includes("'unsafe-eval'"));
check('X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff');
check('X-Frame-Options: DENY', home.headers.get('x-frame-options') === 'DENY');
check('HSTS is set', (home.headers.get('strict-transport-security') ?? '').includes('max-age='));

console.log('\nanonymous — should be refused:');
// A malformed hash costs one regex, not an analysis.
const bad = await req('/tx/base/0xnope');
check('a malformed hash 404s', bad.status === 404, `status ${bad.status}`);

// The QA route is dev-only. If this ever returns 200 in production, it is an
// open, unmetered door to the RPC bill.
const qa = await req(`/qa/tx/base/${KNOWN_HASH}`);
check(
	'/qa is not reachable in production',
	qa.status === 404,
	`status ${qa.status}${qa.status !== 404 ? ' — QA ROUTE IS LIVE' : ''}`,
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length) {
	console.log('Failures:');
	for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);

	// This one gets its own paragraph, loud, because it is not "a check failed" —
	// it is "an unmetered RPC-spending route is reachable by anyone on the
	// internet." /qa has NO rate limiting; it relies entirely on the NODE_ENV
	// guard being the first statement in the route. If that guard ever fails
	// open, this is the only check — local or in CI — that would catch it
	// against a real deployment.
	const qaHole = failed.some((f) => /QA ROUTE IS LIVE/.test(f.detail ?? ''));
	if (qaHole) {
		console.log(
			'\n⚠️⚠️  /qa ANSWERED IN PRODUCTION. This route has no rate limiting at all —\n' +
				'anyone with the URL can trigger unlimited n × ~40 RPC-call analyses for free.\n' +
				'Treat this as an active incident, not routine drift: pull the deploy or fix\n' +
				'the NODE_ENV guard in app/qa/tx/[chain]/[hashes]/page.tsx before anything else.',
		);
	}
}
console.log();
process.exit(failed.length ? 1 : 0);
