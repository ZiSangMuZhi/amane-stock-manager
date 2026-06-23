import { describe, expect, it } from 'vitest';
import { createInventory, submitBarcode, updateNickname, updatePrice } from '../src/shared/inventoryLogic';

describe('inventory logic', () => {
  it('records barcode intake and aggregates stock', () => {
    const first = submitBarcode(createInventory('测试库存'), ' 4901234567890 ', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const second = submitBarcode(first.inventory, '4901234567890', 'in', '2026-06-23T12:01:00.000Z', () => 'tx-2');

    expect(second.ok).toBe(true);
    expect(second.inventory.items['4901234567890']?.quantityOnHand).toBe(2);
    expect(second.inventory.transactions).toHaveLength(2);
  });

  it('blocks outbound scans when stock is zero', () => {
    const result = submitBarcode(createInventory('テスト'), 'ABC-001', 'out');

    expect(result.ok).toBe(false);
    expect(result.inventory.transactions).toHaveLength(0);
    expect(result.inventory.items['ABC-001']).toBeUndefined();
  });

  it('keeps utf-8 nicknames as user data', () => {
    const inventory = updateNickname(createInventory('Stock'), 'abc', '中文 / 日本語 / English');

    expect(inventory.items.abc?.nickname).toBe('中文 / 日本語 / English');
  });

  it('stores item prices and currency for value statistics', () => {
    const stocked = submitBarcode(createInventory('Gunpla'), '4573102661449', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const priced = updatePrice(stocked.inventory, '4573102661449', 2480.559, 'JPY', '2026-06-23T12:01:00.000Z');

    expect(priced.items['4573102661449']?.priceAmount).toBe(2480.56);
    expect(priced.items['4573102661449']?.priceCurrency).toBe('JPY');
  });
});
