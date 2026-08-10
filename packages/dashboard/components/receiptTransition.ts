'use client';
/**
 * What the receipt route's Suspense fallback needs to know that the server
 * cannot tell it: which receipt was already on screen, and which loader word
 * the click that started this navigation drew.
 *
 * Why a store rather than props: navigating to a new hash mounts a NEW page, so
 * the old page's React state is gone by the time the fallback renders. Next
 * commits the incoming route's shell and shows its fallback — it does not hold
 * the previous page on screen — so the only way for the fallback to show the
 * receipt the reader was just looking at is for that receipt to outlive the
 * component that rendered it. A module-level store does; it lives as long as
 * the tab.
 *
 * ⚠️ SSR SAFETY: module state on the server is shared across every request, so
 * a value written there would leak one visitor's receipt into another's HTML.
 * Nothing writes on the server — the only setter for `receipt` runs in an
 * effect — and `useReceiptTransition` passes a `getServerSnapshot` that returns
 * the empty state, so a server render always sees "no previous receipt". That
 * is also correct on the merits: a hard navigation HAS no previous receipt.
 */
import { useSyncExternalStore } from 'react';
import type { ReceiptModel } from '../lib/receiptModel';

export interface ReceiptTransition {
	/** The receipt on screen when the current navigation started, if any. */
	receipt: ReceiptModel | null;
	/** The loader word drawn for this navigation, or null on a hard navigation. */
	word: string | null;
}

const EMPTY: ReceiptTransition = { receipt: null, word: null };

let state: ReceiptTransition = EMPTY;
const listeners = new Set<() => void>();

function emit(next: ReceiptTransition) {
	state = next;
	for (const listener of listeners) listener();
}

/** Called from an effect once a receipt has rendered — never during SSR. */
export function rememberReceipt(receipt: ReceiptModel) {
	if (state.receipt === receipt) return;
	emit({ ...state, receipt });
}

/** Called from the click handler that starts a navigation, before the transition. */
export function setLoaderWord(word: string) {
	emit({ ...state, word });
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSnapshot(): ReceiptTransition {
	return state;
}

/** The empty state on the server: a hard navigation has no previous receipt. */
export function getServerSnapshot(): ReceiptTransition {
	return EMPTY;
}

export function useReceiptTransition(): ReceiptTransition {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam — the store outlives a single test otherwise. */
export function resetReceiptTransition() {
	emit(EMPTY);
}
