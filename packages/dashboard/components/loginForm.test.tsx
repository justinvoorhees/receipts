import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// tsconfig sets jsx: "preserve", so esbuild emits the classic transform and the
// component modules need React in scope. Same shim methodology/page.test.tsx uses.
globalThis.React = React;

// ReceiptSearch calls useRouter(); the app-router context is not mounted under
// renderToStaticMarkup, so stub it the same way tradesTable.test.tsx does.
vi.mock('next/navigation', () => ({
	useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { LoginForm, LoginErrorNotice } from './loginForm';
import { ReceiptSearch } from './receiptSearch';

/** Outermost wrapper class of a rendered control. */
function wrapperClass(html: string): string {
	return /^<div class="([^"]*)"/.exec(html)?.[1] ?? '';
}

const loginHtml = () => renderToStaticMarkup(<LoginForm next="/trades" />);
const searchHtml = () =>
	renderToStaticMarkup(<ReceiptSearch hash="" failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);

// Figma 625:148 (/trades-auth) and the index bar are the same control. The
// heights drifting apart is exactly the kind of near-miss that makes two
// primary inputs read as two components instead of one.
describe('the /trades password bar and the index receipt bar are the same control', () => {
	it('both render a 40px-high input row', () => {
		expect(loginHtml()).toContain('h-[40px]');
		expect(searchHtml()).toContain('h-[40px]');
	});

	it('neither uses a different height', () => {
		for (const html of [loginHtml(), searchHtml()]) {
			const heights = [...html.matchAll(/h-\[(\d+)px\]/g)].map((m) => m[1]);
			expect(new Set(heights)).toEqual(new Set(['40']));
		}
	});

	// Figma 628:234 puts the error message 10px under the bar. The index used to
	// sit at 20px; the two must not disagree.
	it('both space the error message 10px below the bar', () => {
		expect(wrapperClass(loginHtml())).toContain('gap-[10px]');
		expect(wrapperClass(searchHtml())).toContain('gap-[10px]');
	});

	it('use an identical wrapper, not merely a similar one', () => {
		expect(wrapperClass(loginHtml())).toBe(wrapperClass(searchHtml()));
	});

	// The index sets no placeholder colour, so the browser's muted default
	// applies. Forcing one on /trades made the two fields disagree.
	it('neither overrides the placeholder colour', () => {
		expect(loginHtml()).not.toContain('placeholder:');
		expect(searchHtml()).not.toContain('placeholder:');
	});

	// A button disabled on an empty field renders at opacity-70, reading as muted
	// rather than primary. The index only disables while submitting.
	it('renders the action button enabled on an untouched form', () => {
		expect(loginHtml()).not.toContain('disabled=""');
	});

	it('gives both action buttons the same classes', () => {
		const buttonClass = (html: string) => /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
		expect(buttonClass(loginHtml())).toBe(buttonClass(searchHtml()));
	});

	it('gives both text fields the same classes', () => {
		const inputClass = (html: string) => /class="(h-full min-w-0 flex-1[^"]*)"/.exec(html)?.[1] ?? '';
		expect(inputClass(loginHtml())).not.toBe('');
		expect(inputClass(loginHtml())).toBe(inputClass(searchHtml()));
	});
});

// The index renders its failure through FailureNotice; the password error has to
// land on the same typography and colour rather than approximating it.
describe('LoginErrorNotice matches the index error treatment', () => {
	const errorHtml = renderToStaticMarkup(<LoginErrorNotice message="Incorrect password" />);

	it('renders the message', () => {
		expect(errorHtml).toContain('Incorrect password');
	});

	// React escapes the apostrophes in the class attribute, so match the token
	// itself rather than the authored `font-['Sohne_Breit']` spelling.
	it('uses Sohne Breit at 12/12', () => {
		expect(errorHtml).toContain('Sohne_Breit');
		expect(errorHtml).toContain('text-[12px]');
		expect(errorHtml).toContain('leading-[12px]');
	});

	it('uses the shared red token, not a hard-coded hex', () => {
		expect(errorHtml).toContain('var(--color-red)');
		expect(errorHtml).not.toContain('#fa0b54');
	});

	it('carries the same classes FailureNotice uses for a plain message', () => {
		const plain = renderToStaticMarkup(<FailureNoticePlain />);
		expect(wrapperSpanClass(errorHtml)).toBe(wrapperSpanClass(plain));
	});

	it('is announced to assistive tech', () => {
		expect(errorHtml).toContain('role="alert"');
	});
});

/** The plain (tooltip-less) branch of FailureNotice, inlined for comparison. */
function FailureNoticePlain() {
	return (
		<span className="font-['Sohne_Breit'] text-[12px] leading-[12px]" style={{ color: 'var(--color-red)' }}>
			Transaction not found
		</span>
	);
}

function wrapperSpanClass(html: string): string {
	return /class="([^"]*)"/.exec(html)?.[1] ?? '';
}
