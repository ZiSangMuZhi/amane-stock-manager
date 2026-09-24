import { describe, expect, it } from 'vitest';
import { createInventory, submitBarcode } from '../src/shared/inventoryLogic';
import type { InventoryFile, ShopOperation, StockRecord } from '../src/shared/types';
import { CloudError, inventoryHash, SyncAdapter, SyncEngine, SyncJournal } from '../src/main/cloudSync';

const imageId = '24401954-4f11-4dac-89d1-9164842c541b';
const listing: ShopOperation = { type: 'shop-listing-batch', barcodes: ['123456'], listed: true };
const image: ShopOperation = { type: 'shop-image', barcode: '123456', imageId };
function fixture() {
  let local = submitBarcode(createInventory('synthetic'), '123456', 'in').inventory;
  local.items['123456']!.listed = false;
  let remote = structuredClone(local), version = 3;
  const journal: SyncJournal = { accountId: 'a', filePath: 'C:/synthetic/a.json', inventoryId: local.inventoryId, version,
    baseHash: inventoryHash(local), pending: null, conflict: false, lastSuccess: null, shopOperationsSupported: true };
  let persisted = structuredClone(journal);
  const events: string[] = [], wires: string[] = [], reports: string[] = [];
  const record = (): StockRecord => ({ id: remote.inventoryId, version, inventory: structuredClone(remote), updatedAt: remote.updatedAt,
    shopRegisteredBarcodes: ['123456'], shopOperationsSupported: true });
  const adapter: SyncAdapter = {
    server: 'https://synthetic.invalid', read: async () => structuredClone(local),
    change: async (_path, id, update) => { expect(id).toBe(local.inventoryId); events.push('local'); local = update(local); },
    save: async value => { events.push(value.shopOperationPending ? 'save-operation' : 'save-ack'); persisted = structuredClone(value); },
    report: (_state, message) => { reports.push(message); },
    request: async (method, id, body) => {
      expect(id).toBe(local.inventoryId); events.push(method);
      if (method !== 'GET') { expect(method).toBe('PUT'); remote = JSON.parse(body!).inventory; version++; }
      return record();
    },
    shopOperation: async (id, body) => {
      expect(id).toBe(local.inventoryId); expect(persisted.shopOperationPending?.body).toBe(body);
      events.push('operation'); wires.push(body);
      const { operation, version: expected } = JSON.parse(body) as { operation: ShopOperation; version: number };
      expect(expected).toBe(version);
      if (operation.type === 'shop-image') remote.items[operation.barcode]!.shop.imageId = operation.imageId;
      else for (const barcode of operation.barcodes) remote.items[barcode]!.listed = operation.listed;
      version++;
      return record();
    }
  };
  const engine = new SyncEngine(journal, adapter);
  return { engine, journal, adapter, events, wires, reports, record,
    get local() { return local; }, set local(value: InventoryFile) { local = value; },
    get persisted() { return persisted; }, get remote() { return remote; }
  };
}

describe('durable shop operation queue', () => {
  it.each([listing, image])('writes intent before sending and acknowledges the book and registered catalog fields: $type', async operation => {
    const h = fixture(); await h.engine.shopOperation(operation);
    expect(h.events.indexOf('save-operation')).toBeLessThan(h.events.indexOf('operation'));
    expect(h.events.indexOf('local')).toBeLessThan(h.events.indexOf('save-ack'));
    expect(h.persisted.shopOperationPending).toBeUndefined(); expect(h.journal.version).toBe(4);
    expect(h.local.items['123456']).toMatchObject(operation.type === 'shop-image' ? { shop: { imageId } } : { listed: true });
    expect(h.journal.registeredBarcodes).toEqual(['123456']); expect(h.events).not.toContain('PUT');
  });
  it('never sends if the write-ahead save fails and leaves the old journal intact', async () => {
    const h = fixture(), before = structuredClone(h.journal);
    h.adapter.save = async () => { throw new Error('disk unavailable'); };
    await expect(h.engine.shopOperation(listing)).rejects.toThrow('disk');
    expect(h.journal).toEqual(before); expect(h.wires).toHaveLength(0);
  });
  it.each([0, 500, 502, 503, 408, 429])('retains exact bytes after ambiguous failure %i and replays on restart', async status => {
    const h = fixture(), original = h.adapter.shopOperation!;
    h.adapter.shopOperation = async (_id, body) => { h.wires.push(body); throw new CloudError('untrusted body', status); };
    await expect(h.engine.shopOperation(image)).rejects.toThrow('原请求已保留');
    const pending = structuredClone(h.persisted.shopOperationPending!);
    expect(pending).toBeDefined(); expect(h.events).not.toContain('PUT'); expect(h.reports.join()).not.toContain('untrusted');
    h.adapter.shopOperation = original;
    const restarted = new SyncEngine(structuredClone(h.persisted), h.adapter); await restarted.run();
    expect(h.wires).toEqual([pending.body, pending.body]); expect(h.persisted.shopOperationPending).toBeUndefined();
  });
  it.each([400, 403, 404, 405, 409, 410, 413, 422, 428])('clears a known rejection %i without stock recreation or stock/price journal changes', async status => {
    const h = fixture(); let other: unknown;
    h.adapter.shopOperation = async () => {
      // Protect even an unexpected mixed legacy journal: only this queue can be cleared.
      h.journal.pending = { method: 'PUT', version: 3, requestKey: 'other-key', hash: 'stock', body: 'original-stock' };
      h.journal.shopPricePending = [{ barcode: 'other' }] as never;
      other = structuredClone({ pending: h.journal.pending, prices: h.journal.shopPricePending });
      throw new CloudError('server private text', status, true, true);
    };
    await expect(h.engine.shopOperation(listing)).rejects.toBeInstanceOf(CloudError);
    expect(h.persisted.shopOperationPending).toBeUndefined();
    expect({ pending: h.persisted.pending, prices: h.persisted.shopPricePending }).toEqual(other);
    expect(h.journal.conflict).toBe(false); expect(h.events).not.toContain('GET'); expect(h.events).not.toContain('POST');
    expect(h.reports.join()).not.toContain('server private text');
  });
  it('keeps a definitively rejected operation if clearing its durable journal fails', async () => {
    const h = fixture(), save = h.adapter.save;
    h.adapter.shopOperation = async () => { throw new CloudError('rejected', 409); };
    h.adapter.save = async value => { if (!value.shopOperationPending) throw new Error('disk'); await save(value); };
    await expect(h.engine.shopOperation(listing)).rejects.toThrow('原请求仍保留');
    expect(h.persisted.shopOperationPending).toEqual(h.journal.shopOperationPending);
  });
  it('retains the intent if reading a successful response exceeds the size bound', async () => {
    const h = fixture(); h.adapter.shopOperation = async () => { throw new CloudError('response too large', 413); };
    await expect(h.engine.shopOperation(image)).rejects.toThrow('原请求已保留');
    expect(h.persisted.shopOperationPending).toBeDefined();
  });
  it('recovers server commit plus failed acknowledgement, without restoring the old local field', async () => {
    const h = fixture(), dispatch = h.adapter.shopOperation!, save = h.adapter.save; let committed: StockRecord;
    h.adapter.shopOperation = async (id, body) => { committed = await dispatch(id, body); return committed; };
    h.adapter.save = async value => { if (!value.shopOperationPending) throw new Error('disk'); await save(value); };
    await expect(h.engine.shopOperation(image)).rejects.toThrow('原请求已保留');
    expect(h.local.items['123456']!.shop.imageId).toBe(imageId);
    const pending = h.persisted.shopOperationPending!;
    h.local.items['123456']!.nickname = 'new unrelated edit';
    h.adapter.save = save;
    h.adapter.shopOperation = async (_id, body) => { expect(body).toBe(pending.body); return committed; };
    await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(h.local.items['123456']!.shop.imageId).toBe(imageId); expect(h.local.items['123456']!.nickname).toBe('new unrelated edit');
    expect(h.persisted.shopOperationPending).toBeUndefined(); expect(h.events).toContain('PUT');
  });
  it('replays a lost success response exactly and retains edits made during the upload', async () => {
    const h = fixture(), dispatch = h.adapter.shopOperation!; let committed: StockRecord;
    h.adapter.shopOperation = async (id, body) => {
      committed = await dispatch(id, body); h.local = submitBarcode(h.local, '123456', 'in').inventory;
      throw new Error('lost response');
    };
    await expect(h.engine.shopOperation(listing)).rejects.toThrow(); const pending = h.persisted.shopOperationPending!;
    h.adapter.shopOperation = async (_id, body) => { expect(body).toBe(pending.body); return committed; };
    await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(h.local.items['123456']!.quantityOnHand).toBe(2); expect(h.local.items['123456']!.listed).toBe(true);
    expect(h.events).toContain('PUT');
  });
  it.each(['image', 'incarnation', 'deleted'])('does not overwrite a concurrently changed target: %s', async kind => {
    const h = fixture(), dispatch = h.adapter.shopOperation!;
    h.adapter.shopOperation = async (id, body) => {
      const result = await dispatch(id, body);
      if (kind === 'deleted') delete h.local.items['123456'];
      else if (kind === 'image') h.local.items['123456']!.shop.imageId = '37520f98-d017-4b05-83b7-e0117c98b213';
      else { h.local.items['123456']!.createdAt = '2020-01-01T00:00:00.000Z'; }
      return result;
    };
    await h.engine.shopOperation(image);
    if (kind === 'deleted') expect(h.local.items['123456']).toBeUndefined();
    else expect(h.local.items['123456']!.shop.imageId).toBe(kind === 'image' ? '37520f98-d017-4b05-83b7-e0117c98b213' : null);
  });
  it.each(['conflict', 'shopPriceConflict', 'shopPricePending', 'pending', 'dirty', 'unsupported'])('refuses a new operation while %s', async condition => {
    const h = fixture();
    if (condition === 'conflict' || condition === 'shopPriceConflict') h.journal[condition] = true;
    if (condition === 'shopPricePending') h.journal.shopPricePending = [{}] as never;
    if (condition === 'pending') h.journal.pending = {} as never;
    if (condition === 'dirty') h.local.items['123456']!.nickname = 'dirty';
    if (condition === 'unsupported') delete h.journal.shopOperationsSupported;
    await expect(h.engine.shopOperation(listing)).rejects.toBeInstanceOf(CloudError); expect(h.wires).toHaveLength(0);
  });
  it('blocks conflict resolutions and new operations while a metadata request is unconfirmed', async () => {
    const h = fixture(); h.adapter.shopOperation = async () => { throw new Error('offline'); };
    await expect(h.engine.shopOperation(image)).rejects.toThrow(); const pending = structuredClone(h.persisted.shopOperationPending);
    h.journal.conflict = true;
    for (const action of [() => h.engine.useLocal(), () => h.engine.useCloud(), () => h.engine.resolveShopPrices('keep-shop'), () => h.engine.shopOperation(listing)]) {
      await expect(action()).rejects.toThrow('不能丢弃');
    }
    expect(h.journal.shopOperationPending).toEqual(pending);
  });
});
