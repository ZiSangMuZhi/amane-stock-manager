import { describe, expect, it } from 'vitest';
import type { InventoryItem } from '../src/shared/types';
import { cardPriceDirty, keepCardPrice, parseCardPrice, parseCardPrices, receiveCardPrice, receiveCardPrices, startCardPrice } from '../src/renderer/cardPriceDraft';
const item = { barcode: '123', createdAt: '2026-01-01', priceAmount: 4, salePriceAmount: 10, priceCurrency: 'CAD' } as InventoryItem;
describe('card price refresh boundaries', () => {
  it('retains partially edited values during quantity, image and identical cloud refreshes', () => {
    const state = startCardPrice('file-a', item), dirty = { ...state, draft: { ...state.draft, saleAmount: '' } }, map = { '123': dirty };
    expect(cardPriceDirty(dirty)).toBe(true);
    expect(receiveCardPrices(map, 'file-a', [{ ...item, quantityOnHand: 99 }])).toBe(map);
    expect(parseCardPrice('', '售价')).toBeNull(); expect(parseCardPrice('0', '售价')).toBe(0);
  });
  it('blocks conflicting blur saves and acknowledgement requires explicit save', () => {
    const state = startCardPrice('a', item), draft = { ...state, draft: { ...state.draft, saleAmount: '11.20' } };
    const next = { ...item, salePriceAmount: 12 };
    const conflict = receiveCardPrice(draft, 'a', next);
    expect(conflict.conflict).toBe(true); expect(conflict.draft.saleAmount).toBe('11.20');
    expect(keepCardPrice(conflict, next)).toMatchObject({ conflict: false, manual: true, draft: { saleAmount: '11.20' } });
    expect(startCardPrice('a', next).draft.saleAmount).toBe('12');
  });
  it('resets across files, recreated items and removed items without leaking old drafts', () => {
    const initial = startCardPrice('a', item), dirty = { ...initial, draft: { ...initial.draft, saleAmount: '99' } };
    expect(receiveCardPrice(dirty, 'b', item).draft.saleAmount).toBe('10');
    expect(receiveCardPrice(dirty, 'a', { ...item, createdAt: '2026-02-01' }).draft.saleAmount).toBe('10');
    expect(receiveCardPrices({ '123': dirty }, 'a', [])).toEqual({});
  });
  it('treats currency changes as real external changes without converting numeric input', () => {
    const initial = startCardPrice('a', item), dirty = { ...initial, draft: { ...initial.draft, purchaseAmount: '5' } };
    expect(receiveCardPrice(dirty, 'a', { ...item, priceCurrency: 'JPY' })).toMatchObject({ conflict: true, draft: { currency: 'CAD', purchaseAmount: '5' } });
  });
  it('keeps the existing billion-unit internal/non-CAD limit and only caps linked CAD sale edits', () => {
    const draft = { purchaseAmount: '1000000000', saleAmount: '1000000000', currency: 'JPY' as const };
    expect(parseCardPrices(draft, { ...item, priceCurrency: 'JPY' })).toEqual({ purchasePrice: 1_000_000_000, salePrice: 1_000_000_000 });
    expect(parseCardPrices({ ...draft, currency: 'CAD', saleAmount: '1000000' }, item).salePrice).toBe(1_000_000);
    expect(() => parseCardPrices({ ...draft, currency: 'CAD', saleAmount: '1000000.01' }, item)).toThrow('同步到商店');
    expect(parseCardPrices({ ...draft, currency: 'CAD' }, { ...item, priceCurrency: 'JPY' }).salePrice).toBe(1_000_000_000);
    expect(parseCardPrices({ ...draft, currency: 'CAD', saleAmount: '' }, item).salePrice).toBeNull();
  });
  it.each(['abc', '-1', '1e2', '1.001', '1000000001'])('rejects invalid amount %s instead of saving null/zero', value => {
    expect(() => parseCardPrice(value, '售价')).toThrow();
  });
});
