import { describe, expect, it } from 'vitest';
import type { ShopFields } from '../src/shared/types';
import { keepShopPriceDraft, receiveShopPrice, shopFromPriceDraft, shopItemIdentity, shopPriceDirty, startShopPriceEditor } from '../src/renderer/shopPriceDraft';

const price: ShopFields = { imageId: null, originalCents: 2000, currentCents: 1500, discountBps: 2500, priceSource: 'current' };
describe('shop price drafts', () => {
  it('preserves empty input across unchanged prices and image/background updates', () => {
    const initial = startShopPriceEditor('one', price), dirty = { ...initial, draft: { ...initial.draft, original: '' } };
    expect(shopPriceDirty(dirty)).toBe(true);
    expect(receiveShopPrice(dirty, 'one', { ...price, imageId: 'new-image' })).toBe(dirty);
    expect(() => shopFromPriceDraft(dirty.draft, price)).toThrow('请输入原价');
  });
  it.each(['-1', '1e3', '1.001', 'NaN', 'Infinity', '1000000.01'])('rejects invalid original price %s without silent rounding', value => {
    expect(() => shopFromPriceDraft({ ...startShopPriceEditor('one', price).draft, original: value }, price)).toThrow();
  });
  it('validates current price and computes exact cents using the latest image', () => {
    const draft = { ...startShopPriceEditor('one', price).draft, original: '10.10', current: '.29' };
    expect(shopFromPriceDraft(draft, { ...price, imageId: '12345678-1234-4234-8234-123456789012' })).toMatchObject({ originalCents: 1010, currentCents: 29, imageId: '12345678-1234-4234-8234-123456789012' });
    expect(() => shopFromPriceDraft({ ...draft, current: '' }, price)).toThrow('请输入现价');
    expect(() => shopFromPriceDraft({ ...draft, current: '11' }, price)).toThrow('不能高于');
  });
  it('validates percentage and canonical rounding without submitting inactive input', () => {
    const draft = { original: '9.99', current: '', discount: '15', priceSource: 'discount' as const };
    expect(shopFromPriceDraft(draft, price)).toMatchObject({ currentCents: 849, discountBps: 1500 });
    expect(() => shopFromPriceDraft({ ...draft, discount: '100.01' }, price)).toThrow();
    expect(() => shopFromPriceDraft({ ...draft, discount: '' }, price)).toThrow('请输入减价');
  });
  it('refreshes pristine prices but requires acknowledgement before replacing dirty drafts', () => {
    const initial = startShopPriceEditor('one', price), next = { ...price, originalCents: 3000 };
    expect(receiveShopPrice(initial, 'one', next).draft.original).toBe('30.00');
    const dirty = { ...initial, draft: { ...initial.draft, current: '12.50' } };
    const conflict = receiveShopPrice(dirty, 'one', next);
    expect(conflict.conflict).toBe(true); expect(conflict.draft.current).toBe('12.50');
    expect(receiveShopPrice(conflict, 'one', { ...next })).toBe(conflict);
    const kept = keepShopPriceDraft(conflict, next);
    expect(kept.conflict).toBe(false); expect(kept.draft.current).toBe('12.50'); expect(shopPriceDirty(kept)).toBe(true);
    expect(startShopPriceEditor('one', next).draft.current).toBe('15.00');
    expect(receiveShopPrice(kept, 'one', { ...next, currentCents: 1400 }).conflict).toBe(true);
  });
  it('resets dirty values/conflicts for a different item incarnation', () => {
    const oldKey = shopItemIdentity({ barcode: '123', createdAt: '2026-01-01' }), newKey = shopItemIdentity({ barcode: '123', createdAt: '2026-02-01' });
    expect(newKey).not.toBe(oldKey);
    const initial = startShopPriceEditor(oldKey, price), dirty = { ...initial, draft: { ...initial.draft, original: '' }, conflict: true };
    expect(receiveShopPrice(dirty, newKey, price)).toEqual(startShopPriceEditor(newKey, price));
  });
});
