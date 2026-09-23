import { describe, expect, it } from 'vitest';
import { createInventory, createInventoryItem, updatePrice, updateShop } from '../src/shared/inventoryLogic';

function fixture() {
  const inventory = createInventory('Price sync');
  inventory.items['123'] = { ...createInventoryItem('123'), priceAmount: 3, salePriceAmount: 10,
    shop: { imageId: null, originalCents: 1200, currentCents: 1000, discountBps: 1667, priceSource: 'current' } };
  return inventory;
}

describe('linked CAD sale and shop prices', () => {
  it('updates the current shop price and keeps the original price for discounts', () => {
    const before = fixture(), after = updatePrice(before, '123', 3, 8, 'CAD');
    expect(after.items['123']!.shop).toMatchObject({ originalCents: 1200, currentCents: 800, discountBps: 3333, priceSource: 'current' });
    expect(before.items['123']!.shop.currentCents).toBe(1000);
    expect(after.transactions).toEqual(before.transactions);
  });
  it('raises the original price only when necessary and accepts explicit zero', () => {
    expect(updatePrice(fixture(), '123', 3, 15.67, 'CAD').items['123']!.shop).toMatchObject({originalCents:1567,currentCents:1567,discountBps:0});
    expect(updatePrice(fixture(), '123', 3, 0, 'CAD').items['123']!.shop).toMatchObject({currentCents:0,discountBps:10000});
  });
  it('does not reprice on cost changes, blank sale or a currency change', () => {
    const before = fixture();
    for (const [cost, sale, currency] of [[4,10,'CAD'],[3,null,'CAD'],[3,10,'JPY']] as const) {
      expect(updatePrice(before, '123', cost, sale, currency).items['123']!.shop).toEqual(before.items['123']!.shop);
    }
    before.items['123']!.priceCurrency = 'JPY';
    expect(updatePrice(before, '123', 3, 900, 'JPY').items['123']!.shop).toEqual(before.items['123']!.shop);
    expect(updatePrice(before, '123', 3, 10, 'CAD').items['123']!.shop).toEqual(before.items['123']!.shop);
  });
  it('applies shop discounts back to CAD sale but preserves cost and non-CAD sale', () => {
    const before = fixture(), price = { ...before.items['123']!.shop, priceSource:'discount' as const, discountBps:2500 };
    expect(updateShop(before,'123',price).items['123']).toMatchObject({priceAmount:3,salePriceAmount:9,shop:{currentCents:900}});
    before.items['123']!.priceCurrency = 'JPY';
    expect(updateShop(before,'123',price).items['123']!.salePriceAmount).toBe(10);
  });
  it('image-only edits preserve an intentionally blank internal sale', () => {
    const before = fixture(); before.items['123']!.salePriceAmount = null;
    expect(updateShop(before,'123',{...before.items['123']!.shop,imageId:'12345678-1234-4123-8123-123456789abc'}).items['123']!.salePriceAmount).toBeNull();
  });
  it('rejects a CAD sale larger than the storefront maximum without mutating input', () => {
    const before = fixture();
    expect(() => updatePrice(before,'123',3,1000000.01,'CAD')).toThrow();
    expect(before.items['123']!.salePriceAmount).toBe(10);
  });
});
