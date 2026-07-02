import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportInventoryFile } from '../src/main/exporters';
import { readInventoryFile } from '../src/main/fileStore';

let temporaryDirectory: string | null = null;

describe('inventory file migration and export', () => {
  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it('migrates legacy purchase prices and exports separate sale price columns', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'amane-stock-test-'));
    const inventoryPath = path.join(temporaryDirectory, 'legacy.json');
    await writeFile(
      inventoryPath,
      JSON.stringify({
        schemaVersion: 5,
        inventoryName: '旧库存',
        items: {
          '4573102661449': {
            barcode: '4573102661449',
            nickname: 'HG Abyss',
            priceAmount: 24.5,
            priceCurrency: 'CAD',
            quantityOnHand: 2
          }
        },
        transactions: []
      }),
      'utf-8'
    );

    const inventory = await readInventoryFile(inventoryPath);
    const item = inventory.items['4573102661449'];
    expect(item?.priceAmount).toBe(24.5);
    expect(item?.salePriceAmount).toBeNull();

    if (item) {
      item.salePriceAmount = 31;
    }

    const exportPath = path.join(temporaryDirectory, 'items.csv');
    await exportInventoryFile(inventory, 'csv-items', exportPath);
    const csv = await readFile(exportPath, 'utf-8');

    expect(csv).toContain('purchasePriceAmount');
    expect(csv).toContain('salePriceAmount');
    expect(csv).toContain('saleStockValue');
    expect(csv).toContain('grossProfitValue');
    expect(csv).toContain('49,49,62,13');
  });
});
