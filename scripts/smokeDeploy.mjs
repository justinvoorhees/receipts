/**
 * smokeDeploy.mjs — verify a deployed instance behaves the way it does locally.
 *
 * Checks the access boundary against a running deployment: what an anonymous
 * visitor may do, what they may not, and that the app is actually configured.
 * Read-only — it never deletes and never analyses a new transaction, so it
 * costs no RPC and cannot damage the corpus.
 *
 *   node scripts/smokeDeploy.mjs https://your-app.up.railway.app
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
	console.error('usage: node scripts/smokeDeploy.mjs <base-url>');
	process.exit(2);
}

// A hash already in the corpus: proves the public read path works without
// triggering an analysis (a cache hit costs one DB read, no RPC).
const KNOWN_HASH = '0xbdaa6662fa12410d329d8954e46ea611f8a3a2008426151cba1c37121edbc9ce';

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(path, init = {}) {
	try {
		const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
		return { status: res.status, body: await res.text() };
	} catch (e) {
		return { status: 0, body: String(e.message) };
	}
}

console.log(`\nSmoke-testing ${base}\n`);

console.log('anonymous — should work:');
const home = await req('/');
check('GET /  serves the receipt tool', home.status === 200, `status ${home.status}`);
check('GET /methodology', (await req('/methodology')).status === 200);
const known = await req('/api/receipts', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ hash: KNOWN_HASH }),
});
check(
	'POST /api/receipts returns a stored receipt',
	known.status === 200 && known.body.includes('txHash'),
	`status ${known.status}`,
);

console.log('\nanonymous — should be refused:');
const trades = await req('/trades');
check('GET /trades responds', trades.status === 200, `status ${trades.status}`);
check('  …without leaking history', !trades.body.includes('>History<'));
check('  …and shows the password bar', trades.body.includes('type="password"'),
	trades.body.includes('not configured') ? 'GATE NOT CONFIGURED — set APP_ACCESS_PASSWORD + APP_SESSION_SECRET' : '');
check('  …with no transaction hashes in the HTML', !/0x[a-f0-9]{64}/.test(trades.body));
check('DELETE /api/receipts is refused', (await req('/api/receipts?id=1', { method: 'DELETE' })).status === 401);
check('PUT /api/receipts is refused', (await req('/api/receipts', { method: 'PUT' })).status === 401);
check('GET /api/receipts is refused', (await req('/api/receipts')).status === 401);
check('/login no longer exists', (await req('/login')).status === 404);

console.log('\nconfiguration:');
const badLogin = await req('/api/login', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ password: 'definitely-not-the-password' }),
});
check(
	'login rejects a wrong password (401, not 503)',
	badLogin.status === 401,
	badLogin.status === 503 ? 'gate is NOT configured on the server' : `status ${badLogin.status}`,
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length) {
	console.log('Failures:');
	for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
}
console.log();
process.exit(failed.length ? 1 : 0);
