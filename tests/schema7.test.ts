import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateInventory, readInventoryFile, writeInventoryFile } from '../src/main/fileStore';
import { canonicalShop, createInventory, emptyShop } from '../src/shared/inventoryLogic';

describe('schema 7 migration and public CAD fields', () => {
  it('migrates deterministically without touching original bytes and creates a sibling backup on the first save', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'amane-schema-test-'));
    try {
      const file = path.join(dir, 'old.json');
      const legacy = JSON.stringify({ schemaVersion:6, inventoryName:'Old inventory', createdAt:'2026-01-01T00:00:00.000Z', items:{'123':{barcode:'123',priceCurrency:'CAD',salePriceAmount:12.34,priceAmount:4,quantityOnHand:2,totalIn:5,totalOut:3,listed:true}}, transactions:[] });
      await writeFile(file, legacy);
      const migrated = await readInventoryFile(file), again = await readInventoryFile(file);
      expect(migrated.inventoryId).toBe(again.inventoryId); expect(await readFile(file,'utf8')).toBe(legacy);
      expect(migrated.items['123']).toMatchObject({ listed:false, priceAmount:4, quantityOnHand:2,totalIn:5,totalOut:3,shop:{originalCents:1234,currentCents:1234,imageId:null} });
      await writeInventoryFile(file,migrated);
      const backup = (await readdir(dir)).find(name => name.includes('.backup-'))!;
      expect(await readFile(path.join(dir,backup),'utf8')).toBe(legacy);
      expect((await readInventoryFile(file)).inventoryId).toBe(migrated.inventoryId);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('rejects future schema versions and malformed v7 identities', () => {
    expect(() => migrateInventory({schemaVersion:8,items:{}},'future')).toThrow('较新格式');
    expect(() => migrateInventory({schemaVersion:7,items:{}},'invalid')).toThrow('稳定标识');
  });
  it('leaves non-CAD retail fields independent and defaults every new item to unlisted zero discount-source pricing', () => {
    const old = migrateInventory({schemaVersion:6,items:{'123':{barcode:'123',priceCurrency:'JPY',salePriceAmount:8000,priceAmount:3000}}},'JPY');
    expect(old.items['123']!.shop).toEqual(emptyShop()); expect(emptyShop().priceSource).toBe('discount');
    expect(createInventory('one').inventoryId).not.toBe(createInventory('two').inventoryId);
  });
  it('uses the agreed integer-cent/BPS rounding and validates price bounds', () => {
    expect(canonicalShop({...emptyShop(),originalCents:999,discountBps:1500})).toMatchObject({currentCents:849,discountBps:1500});
    expect(canonicalShop({...emptyShop(),priceSource:'current',originalCents:999,currentCents:500})).toMatchObject({discountBps:4995});
    expect(canonicalShop({...emptyShop(),discountBps:5000})).toMatchObject({currentCents:0,discountBps:0});
    expect(() => canonicalShop({...emptyShop(),originalCents:100000001})).toThrow();
  });
});
