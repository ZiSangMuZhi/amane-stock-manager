import { describe, expect, it } from 'vitest';
import {
  createInventory,
  deleteInventoryItem,
  submitBarcode,
  updateNickname,
  updatePrice,
  updateSortOrder
} from '../src/shared/inventoryLogic';

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
    const stocked = submitBarcode(createInventory('Stock'), 'abc', 'in');
    const inventory = updateNickname(stocked.inventory, 'abc', '中文 / 日本語 / English');

    expect(inventory.items.abc?.nickname).toBe('中文 / 日本語 / English');
  });

  it('stores item prices and currency for value statistics', () => {
    const stocked = submitBarcode(createInventory('Gunpla'), '4573102661449', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const priced = updatePrice(
      stocked.inventory,
      '4573102661449',
      2480.559,
      3200,
      'CAD',
      '2026-06-23T12:01:00.000Z'
    );

    expect(priced.items['4573102661449']?.priceAmount).toBe(2480.56);
    expect(priced.items['4573102661449']?.salePriceAmount).toBe(3200);
    expect(priced.items['4573102661449']?.priceCurrency).toBe('CAD');
  });

  it('deletes an item category and its transactions', () => {
    const stocked = submitBarcode(createInventory('Gunpla'), '4573102661449', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const removed = deleteInventoryItem(stocked.inventory, '4573102661449', '2026-06-23T12:01:00.000Z');

    expect(removed.items['4573102661449']).toBeUndefined();
    expect(removed.transactions).toHaveLength(0);
  });

  it('does not recreate a deleted item from stale field saves', () => {
    const stocked = submitBarcode(createInventory('Gunpla'), '4573102661449', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const removed = deleteInventoryItem(stocked.inventory, '4573102661449', '2026-06-23T12:01:00.000Z');
    const priced = updatePrice(removed, '4573102661449', 25, 30, 'CAD', '2026-06-23T12:02:00.000Z');
    const renamed = updateNickname(priced, '4573102661449', 'stale blur', '2026-06-23T12:03:00.000Z');

    expect(renamed.items['4573102661449']).toBeUndefined();
  });

  it('keeps manual item sort order and places new scans first', () => {
    const first = submitBarcode(createInventory('Gunpla'), 'A', 'in', '2026-06-23T12:00:00.000Z', () => 'tx-1');
    const second = submitBarcode(first.inventory, 'B', 'in', '2026-06-23T12:01:00.000Z', () => 'tx-2');
    const manual = updateSortOrder(second.inventory, ['A', 'B'], '2026-06-23T12:02:00.000Z');
    const third = submitBarcode(manual, 'C', 'in', '2026-06-23T12:03:00.000Z', () => 'tx-3');

    expect(third.inventory.items.C?.sortIndex).toBeLessThan(third.inventory.items.A?.sortIndex ?? 0);
    expect(manual.items.A?.sortIndex).toBe(0);
    expect(manual.items.B?.sortIndex).toBe(1);
  });
});
