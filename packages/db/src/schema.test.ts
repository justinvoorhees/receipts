import { describe, it, expectTypeOf } from 'vitest';
import { schema } from './index.js';

describe('receipts schema', () => {
	it('exposes generalized token + receipt columns', () => {
		type R = typeof schema.receipts.$inferSelect;
		expectTypeOf<R>().toHaveProperty('inputToken');
		expectTypeOf<R>().toHaveProperty('outputToken');
		expectTypeOf<R>().toHaveProperty('pricingStatus');
		expectTypeOf<R>().toHaveProperty('createdAt');
		expectTypeOf<R>().toHaveProperty('userId');
	});
});
