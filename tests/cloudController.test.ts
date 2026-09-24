import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudController } from '../src/main/cloudController';
import { CloudClient } from '../src/main/cloudClient';
import { JournalStore } from '../src/main/cloudStore';
import { createInventory, submitBarcode } from '../src/shared/inventoryLogic';
import { CloudAccount, InventoryDocument, ShopOperation, StockRecord } from '../src/shared/types';
import { CloudError, inventoryHash, SyncJournal } from '../src/main/cloudSync';

const dirs: string[] = [], controllers: CloudController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(c => c.pause())); await Promise.all(dirs.splice(0).map(d => rm(d, {recursive:true,force:true}))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'amane-control-test-')); dirs.push(dir);
  const store = new JournalStore(path.join(dir, 'journal.json')); await store.load();
  const document: InventoryDocument = { filePath: path.join(dir, 'synthetic.json'), fileName: 'synthetic.json', inventory: createInventory('synthetic') };
  const fake = {
    account: null as CloudAccount | null, secureStorage: false,
    login: async (id: string) => { fake.account = { id, username: id, displayName: id, permissions: ['content.manage'], mustChangePassword: false }; },
    logout: async () => { fake.account = null; throw new Error('offline'); },
    requireAccount: () => { if (!fake.account) throw new Error('not logged in'); return fake.account; },
    stock: async () => { throw new Error('offline synthetic transport'); }
  };
  const controller = new CloudController(fake as unknown as CloudClient, store, {
    current: () => document, read: async () => document.inventory,
    change: async (_p,_id,update) => { document.inventory = update(document.inventory!); },
    emit: () => undefined, download: async () => document
  }); controllers.push(controller);
  return { controller, store, document, fake };
}

describe('explicit connection and account switching', () => {
  it('login alone never connects a local file or sends inventory', async () => {
    const h = await fixture(); await h.controller.login('account-a', 'synthetic');
    expect(h.controller.snapshot().connected).toBe(false);
    expect(h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)).toBeUndefined();
  });

  it('keeps an ambiguous request bound to its original account and resumes it on relogin', async () => {
    const h = await fixture(); await h.controller.login('account-a', 'synthetic'); await h.controller.connect(); await h.controller.retry();
    const pending = h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)!.pending;
    expect(pending).not.toBeNull();
    await h.controller.login('account-b', 'synthetic'); expect(h.controller.snapshot().connected).toBe(false);
    expect(h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)!.pending).toEqual(pending);
    await h.controller.login('account-a', 'synthetic'); expect(h.controller.snapshot().connected).toBe(true);
    await h.controller.retry(); expect(h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)!.pending).toEqual(pending);
  });

  it('failed logout stops syncing and relogin restores the existing pending request', async () => {
    const h = await fixture(); await h.controller.login('account-a', 'synthetic'); await h.controller.connect(); await h.controller.retry();
    const before = h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)!.pending;
    await h.controller.logout(); expect(h.controller.snapshot().account).toBeNull(); expect(h.controller.snapshot().connected).toBe(false);
    await h.controller.login('account-a', 'synthetic');
    expect(h.controller.snapshot().connected).toBe(true); expect(h.store.find('account-a', h.document.filePath!, h.document.inventory!.inventoryId)!.pending).toEqual(before);
  });

  it('changing files never activates a copied cloudLink without local consent', async () => {
    const h = await fixture(); await h.controller.login('account-a', 'synthetic'); await h.controller.connect(); await h.controller.pause();
    h.document.filePath = path.join(dirs.at(-1)!, 'different.json');
    h.document.inventory = { ...h.document.inventory!, cloudLink: { server: 'https://evil.invalid', accountId: 'account-a', version: 99, baseHash: 'forged' } };
    await h.controller.selectCurrent(); expect(h.controller.snapshot().connected).toBe(false);
  });
});

async function shopFixture(connected = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'amane-operation-control-')); dirs.push(dir);
  const store = new JournalStore(path.join(dir, 'journal.json')); await store.load();
  const inventory = submitBarcode(createInventory('synthetic'), '123456', 'in').inventory; inventory.items['123456']!.listed = false;
  const document: InventoryDocument = { filePath: path.join(dir, 'synthetic.json'), fileName: 'synthetic.json', inventory };
  let remote = structuredClone(inventory), version = 2, supported: boolean | undefined = true;
  const calls: string[] = [], bodies: string[] = [];
  let beforeGet: (() => void) | undefined, failure: Error | undefined;
  const record = (): StockRecord => ({ id: remote.inventoryId, version, inventory: structuredClone(remote), updatedAt: remote.updatedAt, shopRegisteredBarcodes: [], shopOperationsSupported: supported });
  const fake = {
    account: { id: 'a', username: 'a', displayName: 'a', permissions: ['inventory.manage', 'products.manage'], mustChangePassword: false } as CloudAccount | null,
    secureStorage: false,
    requireAccount: () => { if (!fake.account) throw new CloudError('expired', 401); return fake.account; },
    requireShopOperationAccount: () => { const account = fake.requireAccount(); if (!account.permissions.includes('products.manage')) throw new CloudError('permission', 403); return account; },
    stock: async (method: string, _id: string, body?: string) => {
      calls.push(method);
      if (method === 'GET') beforeGet?.();
      else { remote = JSON.parse(body!).inventory; version++; }
      return record();
    }, products: async () => [],
    stockOperation: async (_id: string, body: string) => {
      calls.push('operation'); bodies.push(body); if (failure) throw failure;
      const { operation } = JSON.parse(body) as { operation: ShopOperation };
      if (operation.type === 'shop-image') remote.items[operation.barcode]!.shop.imageId = operation.imageId;
      else operation.barcodes.forEach(barcode => { remote.items[barcode]!.listed = operation.listed; });
      version++; return record();
    }
  };
  const controller = new CloudController(fake as unknown as CloudClient, store, {
    current: () => structuredClone(document), read: async () => structuredClone(document.inventory),
    change: async (p, id, update) => { expect(p).toBe(document.filePath); expect(id).toBe(document.inventory?.inventoryId); document.inventory = update(document.inventory!); },
    emit: () => undefined, download: async () => document
  }); controllers.push(controller);
  const journal: SyncJournal = { accountId: 'a', filePath: document.filePath!, inventoryId: inventory.inventoryId, version: 2,
    baseHash: inventoryHash(inventory), pending: null, conflict: false, lastSuccess: null };
  if (connected) { await store.save(journal); await controller.selectCurrent(); await controller.pause(); }
  return { controller, fake, document, calls, bodies, store, journal,
    get remote() { return remote; }, set version(value: number) { version = value; },
    set supported(value: boolean | undefined) { supported = value; },
    set beforeGet(value: (() => void) | undefined) { beforeGet = value; },
    set failure(value: Error | undefined) { failure = value; }
  };
}
const shopListing: ShopOperation = { type: 'shop-listing-batch', barcodes: ['123456'], listed: true };
describe('connected shop action control and capabilities', () => {
  it('never implicitly connects or uploads a local-only inventory', async () => {
    const h = await shopFixture(false);
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow('连接当前库存'); expect(h.calls).toEqual([]);
    expect(h.controller.snapshot().connected).toBe(false);
  });
  it('learns capability through sync and accepts clean connected operations', async () => {
    const h = await shopFixture(); expect(h.controller.snapshot().shopOperationsSupported).toBe(false);
    const result = await h.controller.shopOperation(shopListing);
    expect(h.calls[0]).toBe('GET'); expect(h.calls).toContain('operation'); expect(result.inventory?.items['123456']!.listed).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ shopOperationsSupported: true, shopOperationPending: false });
  });
  it('gates old servers before POST then enables the action after a new GET advertises support', async () => {
    const h = await shopFixture(); h.supported = undefined;
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow('升级 Mac 服务端'); expect(h.calls).not.toContain('operation');
    expect(h.controller.snapshot().shopOperationsSupported).toBe(false);
    h.supported = true; await h.controller.shopOperation(shopListing); expect(h.calls).toContain('operation');
  });
  it('finishes ordinary edits before dispatching metadata', async () => {
    const h = await shopFixture(); h.document.inventory!.items['123456']!.quantityOnHand = 9;
    await h.controller.shopOperation(shopListing);
    expect(h.calls.indexOf('PUT')).toBeLessThan(h.calls.indexOf('operation')); expect(h.remote.items['123456']!.quantityOnHand).toBe(9);
  });
  it.each(['image', 'listed', 'incarnation'])('requires a new user choice if pre-sync changes the target %s', async kind => {
    const h = await shopFixture(); h.version = 3;
    const operation: ShopOperation = kind === 'image' ? { type: 'shop-image', barcode: '123456', imageId: null } : shopListing;
    if (kind === 'image') h.remote.items['123456']!.shop.imageId = '37520f98-d017-4b05-83b7-e0117c98b213';
    if (kind === 'listed') h.remote.items['123456']!.listed = true;
    if (kind === 'incarnation') h.remote.items['123456']!.createdAt = '2020-01-01T00:00:00.000Z';
    await expect(h.controller.shopOperation(operation)).rejects.toThrow('云端商品已更新'); expect(h.calls).not.toContain('operation');
  });
  it('permits unrelated remote quantity changes while still applying the selected listing', async () => {
    const h = await shopFixture(); h.version = 3; h.remote.items['123456']!.quantityOnHand = 7;
    await h.controller.shopOperation(shopListing); expect(h.document.inventory!.items['123456']).toMatchObject({ listed: true, quantityOnHand: 7 });
  });
  it.each(['account', 'file', 'inventory'])('refuses an operation after binding changes during pre-sync: %s', async kind => {
    const h = await shopFixture();
    h.beforeGet = () => {
      if (kind === 'account') h.fake.account!.id = 'different';
      if (kind === 'file') h.document.filePath = path.join(dirs.at(-1)!, 'other.json');
      if (kind === 'inventory') h.document.inventory!.inventoryId = '37520f98-d017-4b05-83b7-e0117c98b213';
    };
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow(); expect(h.calls).not.toContain('operation');
  });
  it('retains pending status and the original account/file request on account switching', async () => {
    const h = await shopFixture(); h.failure = new Error('lost response');
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow('原请求已保留');
    expect(h.controller.snapshot()).toMatchObject({ pending: true, shopOperationPending: true });
    const pending = h.store.find('a', h.journal.filePath, h.journal.inventoryId)!.shopOperationPending;
    h.fake.account!.id = 'b'; await h.controller.selectCurrent(); expect(h.controller.snapshot().connected).toBe(false);
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow('连接当前库存');
    expect(h.store.find('a', h.journal.filePath, h.journal.inventoryId)!.shopOperationPending).toEqual(pending);
    h.fake.account!.id = 'a'; await h.controller.selectCurrent(); h.failure = undefined; await h.controller.retry();
    expect(h.bodies).toEqual([pending!.body, pending!.body]); expect(h.controller.snapshot().shopOperationPending).toBe(false);
  });
  it('blocks duplicate actions and all replacement choices while a request is unconfirmed', async () => {
    const h = await shopFixture(); h.failure = new Error('offline');
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow();
    await expect(h.controller.shopOperation(shopListing)).rejects.toThrow('不能丢弃');
    for (const choice of ['use-cloud', 'use-local', 'upload-new'] as const) await expect(h.controller.resolve(choice)).rejects.toThrow('不能丢弃');
    await expect(h.controller.download(h.journal.inventoryId)).rejects.toThrow('不能丢弃'); expect(h.bodies).toHaveLength(1);
  });
});
