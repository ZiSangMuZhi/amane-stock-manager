import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createInventory, submitBarcode, updateShop } from '../src/shared/inventoryLogic';
import type { InventoryFile, StockRecord } from '../src/shared/types';
import { CloudError, inventoryHash, SyncEngine, type SyncAdapter, type SyncJournal } from '../src/main/cloudSync';
import { CloudClient } from '../src/main/cloudClient';
import type { TokenVault } from '../src/main/cloudStore';
import { prepareShopPrices, shopPrice, type ShopProduct, type ShopPriceTransport } from '../src/main/shopPriceSync';

function harness() {
  let local = submitBarcode(createInventory('Synthetic price sync'), '123456', 'in').inventory;
  local = updateShop(local, '123456', { imageId: null, originalCents: 1000, currentCents: 1000, discountBps: 0, priceSource: 'current' });
  let server: StockRecord = { id: local.inventoryId, version: 1, inventory: structuredClone(local), updatedAt: new Date().toISOString(), shopRegisteredBarcodes: ['123456'] };
  let product: ShopProduct = { id: randomUUID(), version: 2, sourceBookId: local.inventoryId, sourceBarcode: '123456',
    shopRegistered: true, deletedAt: null, listed: true, stock: 1,
    content: { name: 'Managed shop title', imageId: randomUUID(), currency: 'CAD', categoryId: randomUUID(), ...shopPrice(local.items['123456']!.shop) } };
  const journal: SyncJournal = { accountId: 'synthetic-account', filePath: 'C:/synthetic-price.json', inventoryId: local.inventoryId,
    version: 1, baseHash: inventoryHash(local), pending: null, conflict: false, lastSuccess: null };
  let persisted = structuredClone(journal);
  const states: string[] = [], messages: string[] = [];
  const priceResponses = new Map<string, ShopProduct>(), stockResponses = new Map<string, StockRecord>();
  const transport: ShopPriceTransport = {
    stock: vi.fn(async () => structuredClone(server)),
    products: vi.fn(async () => [structuredClone(product)]),
    product: vi.fn(async () => structuredClone(product)),
    saveProductPrice: vi.fn(async (id, body) => {
      expect(persisted.shopPricePending?.[0]?.request?.body).toBe(body);
      const payload = JSON.parse(body);
      const replay = priceResponses.get(payload.requestKey);
      if (replay) return structuredClone(replay);
      if (id !== product.id) throw new CloudError('missing product', 404);
      if (payload.version !== product.version) throw new CloudError('stale product', 409);
      product = { ...product, version: product.version + 1, content: { ...product.content, ...payload.content } };
      priceResponses.set(payload.requestKey, structuredClone(product));
      return structuredClone(product);
    })
  };
  const adapter: SyncAdapter = {
    server: 'https://admin.invalid', shopPrices: transport,
    read: async () => structuredClone(local),
    change: async (_path, id, change) => { expect(id).toBe(local.inventoryId); local = change(local); },
    save: vi.fn(async value => { persisted = structuredClone(value); }),
    request: vi.fn(async (method, id, body) => {
      if (method === 'GET') return structuredClone(server);
      expect(persisted.pending?.body).toBe(body);
      const payload = JSON.parse(body!);
      const replay = stockResponses.get(payload.requestKey);
      if (replay) return structuredClone(replay);
      server = { ...server, id, inventory: payload.inventory, version: method === 'POST' ? 1 : server.version + 1 };
      product = { ...product, version: product.version + 1, stock: payload.inventory.items['123456']?.quantityOnHand ?? 0 };
      stockResponses.set(payload.requestKey, structuredClone(server));
      return structuredClone(server);
    }),
    report: (state, message) => { states.push(state); messages.push(message); }
  };
  const engine = new SyncEngine(journal, adapter);
  return { journal, adapter, transport, engine, states, messages,
    get local() { return local; }, set local(value: InventoryFile) { local = value; },
    get server() { return server; }, set server(value: StockRecord) { server = value; },
    get product() { return product; }, set product(value: ShopProduct) { product = value; },
    get persisted() { return persisted; },
    edit(cents = 750) { local = updateShop(local, '123456', { ...local.items['123456']!.shop, priceSource: 'current', currentCents: cents }); }
  };
}

describe('registered shop price synchronization', () => {
  it('ordinary quantity changes never query or rewrite managed shop prices', async () => {
    const h = harness();
    h.local = submitBarcode(h.local, '123456', 'in').inventory;
    await h.engine.run();
    expect(h.product.stock).toBe(2); expect(h.product.content.currentCents).toBe(1000);
    expect(h.transport.products).not.toHaveBeenCalled(); expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toBe('synced'); expect(h.persisted.registeredBarcodes).toEqual(['123456']);
  });

  it('unregistered price edits do not require catalog permissions', async () => {
    const h = harness(); h.server.shopRegisteredBarcodes = []; h.edit();
    await h.engine.run();
    expect(h.transport.products).not.toHaveBeenCalled(); expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    expect(h.server.inventory.items['123456']!.shop.currentCents).toBe(750);
    expect(h.states.at(-1)).toBe('synced');
  });

  it.each([false, true])('retains pre-PUT registration candidates and safely handles a concurrent website price edit: %s', async editedOnWebsite => {
    const h = harness(); h.server.shopRegisteredBarcodes = []; h.product.shopRegistered = false; h.edit();
    const request = h.adapter.request;
    h.adapter.request = async (...args) => {
      if (args[0] === 'PUT') {
        expect(h.persisted.pending?.shopPrices).toEqual([]);
        expect(h.persisted.pending?.shopPriceCandidates?.[0]).toMatchObject({ barcode: '123456', base: { currentCents: 1000 }, desired: { currentCents: 750 } });
        h.product = { ...h.product, shopRegistered: true, content: { ...h.product.content,
          ...(editedOnWebsite ? { currentCents: 900, discountBps: 1000 } : {}) } };
        h.server.shopRegisteredBarcodes = ['123456'];
      }
      return request(...args);
    };
    await h.engine.run();
    expect(h.persisted.pending).toBeNull();
    if (editedOnWebsite) {
      expect(h.product.content.currentCents).toBe(900); expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
      expect(h.persisted.shopPriceConflict).toBe(true); expect(h.persisted.shopPricePending).toHaveLength(1);
      expect(h.states.at(-1)).toBe('error');
    } else {
      expect(h.product.content.currentCents).toBe(750); expect(h.persisted.shopPricePending).toEqual([]);
      expect(h.states.at(-1)).toBe('synced');
    }
  });

  it('fails before the stock write when a known registered product disappeared', async () => {
    const h = harness(); h.edit(); h.transport.products = vi.fn(async () => []);
    await h.engine.run();
    expect(h.adapter.request).not.toHaveBeenCalled(); expect(h.persisted.pending).toBeNull();
    expect(h.states.at(-1)).toBe('error'); expect(h.journal.conflict).toBe(false);
    expect(h.messages.at(-1)).toContain('尚未提交');
  });

  it('requires the exact cloud inventory version before preparing a price edit', async () => {
    const h = harness(); h.edit(); h.server.version = 4;
    await h.engine.run();
    expect(h.adapter.request).not.toHaveBeenCalled(); expect(h.transport.products).not.toHaveBeenCalled();
    expect(h.persisted.conflict).toBe(true);
  });

  it('uses the version after the stock update and preserves the newest managed name/image/category/listing', async () => {
    const h = harness(); h.edit();
    const image = randomUUID(), category = h.product.content.categoryId;
    const request = h.adapter.request;
    h.adapter.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === 'PUT') h.product = { ...h.product, version: h.product.version + 1, content: { ...h.product.content, name: 'Edited on website', imageId: image } };
      return result;
    };
    await h.engine.run();
    const body = JSON.parse(vi.mocked(h.transport.saveProductPrice).mock.calls[0]![1]);
    expect(body.version).toBe(4);
    expect(body.content).toEqual({ name: 'Edited on website', imageId: image, currency: 'CAD', originalCents: 1000, currentCents: 750, discountBps: 2500, priceSource: 'current' });
    expect(body.content).not.toHaveProperty('categoryId');
    expect(h.product.content.categoryId).toBe(category); expect(h.product.listed).toBe(true);
    expect(h.persisted.shopPricePending).toEqual([]); expect(h.states.at(-1)).toBe('synced');
  });

  it('replays exactly the saved price body after commit response loss and a process restart', async () => {
    const h = harness(); h.edit(); const save = h.transport.saveProductPrice;
    let lost = true;
    h.transport.saveProductPrice = vi.fn(async (...args: Parameters<ShopPriceTransport['saveProductPrice']>) => {
      const value = await save(...args); if (lost) { lost = false; throw new Error('lost after commit'); } return value;
    });
    await h.engine.run();
    const body = h.persisted.shopPricePending![0]!.request!.body;
    expect(h.persisted.pending).toBeNull(); expect(h.persisted.version).toBe(2);
    expect(h.states.at(-1)).toBe('error'); expect(h.messages.at(-1)).toContain('库存已同步');
    h.product = { ...h.product, version: h.product.version + 1, content: { ...h.product.content, name: 'Later website edit' } };
    const restarted = new SyncEngine(structuredClone(h.persisted), h.adapter);
    await restarted.run();
    expect(vi.mocked(h.transport.saveProductPrice).mock.calls.map(args => args[1])).toEqual([body, body]);
    expect(h.transport.product).toHaveBeenCalledTimes(1);
    expect(h.product.content.name).toBe('Later website edit');
    expect(h.persisted.shopPricePending).toEqual([]); expect(h.states.at(-1)).toBe('synced');
  });

  it('does not lose prepared price intents if persisting the stock acknowledgement fails', async () => {
    const h = harness(); h.edit(); const save = h.adapter.save; let blocked = true;
    h.adapter.save = async value => {
      if (blocked && !value.pending && value.shopPricePending?.length) throw new Error('disk full during handoff');
      await save(value);
    };
    await h.engine.run();
    expect(h.persisted.pending?.shopPrices).toHaveLength(1);
    expect(h.journal.pending?.shopPrices).toHaveLength(1);
    expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    blocked = false; await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(h.product.content.currentCents).toBe(750); expect(h.persisted.shopPricePending).toEqual([]);
  });

  it('does not send a price if persisting its exact PUT body fails', async () => {
    const h = harness(); h.edit(); const save = h.adapter.save; let blocked = true;
    h.adapter.save = async value => {
      if (blocked && value.shopPricePending?.[0]?.request) throw new Error('disk full before price send');
      await save(value);
    };
    await h.engine.run();
    expect(h.persisted.shopPricePending).toHaveLength(1); expect(h.persisted.shopPricePending![0]!.request).toBeUndefined();
    expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    blocked = false; await h.engine.run();
    expect(h.product.content.currentCents).toBe(750); expect(h.persisted.shopPricePending).toEqual([]);
  });

  it('reports persistent disk failure without rejecting a background run or losing its replayable request', async () => {
    const h = harness(); h.edit(); const write = h.transport.saveProductPrice;
    h.transport.saveProductPrice = vi.fn(async (...args: Parameters<ShopPriceTransport['saveProductPrice']>) => {
      const result = await write(...args);
      h.adapter.save = async () => { throw new Error('disk unavailable'); };
      return result;
    });
    await expect(h.engine.run()).resolves.toBeUndefined();
    expect(h.product.content.currentCents).toBe(750);
    expect(h.persisted.shopPricePending![0]!.request).toBeDefined();
    expect(h.journal.shopPricePending![0]!.request).toBeDefined();
    expect(h.states.at(-1)).toBe('error'); expect(h.messages.at(-1)).toContain('保存失败');
  });

  it.each([403, 404, 429, 500])('retains a price intent and distinguishes product HTTP %i from stock success', async status => {
    const h = harness(); h.edit(); h.transport.product = vi.fn(async () => { throw new CloudError('product failure', status); });
    await h.engine.run();
    expect(h.persisted.pending).toBeNull(); expect(h.persisted.shopPricePending).toHaveLength(1);
    expect(h.persisted.conflict).toBe(false); expect(h.states.at(-1)).toBe('error');
    expect(h.messages.at(-1)).toContain(status === 403 ? '服务器拒绝' : status === 404 ? '已删除' : '待发价格');
    expect(h.messages.at(-1)).not.toContain('product failure');
  });

  it.each([
    { payload: { error: 'REQUEST_VERIFICATION_FAILED', message: 'never-echo-upstream-secret' }, diagnostic: '写入来源或会话校验' },
    { payload: { error: 'PERMISSION_DENIED', message: 'never-echo-upstream-secret' }, diagnostic: '缺少此操作所需的管理权限' },
    { payload: { error: 'PRODUCT_REQUEST_FAILED', message: '当前账号没有定价管理权限，可以编辑名称、图片和库存。' }, diagnostic: '没有定价管理权限' },
    { payload: { error: 'UNKNOWN', message: 'never-echo-upstream-secret' }, diagnostic: '服务器拒绝了此操作（HTTP 403）' },
  ])('preserves the client 403 diagnostic through SyncEngine reports and the durable price queue: $diagnostic', async scenario => {
    const h = harness(); h.edit();
    const vault = { available: false, load: async () => null, save: async () => undefined, clear: async () => undefined } as unknown as TokenVault;
    const client = new CloudClient(vault, async () => new Response(JSON.stringify(scenario.payload), { status: 403, headers: { 'content-type': 'application/json' } }));
    client.account = { id: 'synthetic-account', username: 'synthetic', displayName: 'Synthetic', mustChangePassword: false, permissions: ['products.manage', 'pricing.manage'] };
    h.transport.saveProductPrice = vi.fn((id, body) => client.saveProductPrice(id, body));
    await h.engine.run();
    expect(h.states.at(-1)).toBe('error');
    expect(h.messages.at(-1)).toContain('库存已同步'); expect(h.messages.at(-1)).toContain(scenario.diagnostic);
    expect(h.messages.at(-1)).toContain('待发价格已保留'); expect(h.messages.at(-1)).not.toContain('never-echo-upstream-secret');
    if (scenario.payload.error === 'REQUEST_VERIFICATION_FAILED') expect(h.messages.at(-1)).not.toContain('没有商店商品或价格管理权限');
    expect(h.persisted.pending).toBeNull(); expect(h.persisted.conflict).toBe(false); expect(h.persisted.shopPriceConflict).toBe(false);
    expect(h.persisted.shopPricePending).toHaveLength(1);
    const pendingBody = h.persisted.shopPricePending![0]!.request!.body;
    expect(pendingBody).toBe(vi.mocked(h.transport.saveProductPrice).mock.calls[0]![1]);
    expect(h.transport.saveProductPrice).toHaveBeenCalledOnce(); expect(h.product.content.currentCents).toBe(1000);
  });

  it.each([
    new CloudError('never-echo-unknown-cloud-error', 403),
    new Error('<html>never-echo-unknown-transport-error</html>'),
    { status: 403, message: 'never-echo-non-CloudError-object' },
  ])('uses fixed fallback for unrecognized or untyped transport errors %#', async error => {
    const h = harness(); h.edit(); h.transport.saveProductPrice = vi.fn(async () => { throw error; });
    await h.engine.run();
    expect(h.messages.at(-1)).toBe(error instanceof CloudError
      ? '库存已同步，商店价格请求被服务器拒绝（HTTP 403）。 待发价格已保留。'
      : '库存已同步，商店价格同步中断，待发价格已保留，请重试。');
    expect(h.persisted.shopPricePending?.[0]?.request).toBeDefined(); expect(h.persisted.conflict).toBe(false);
    expect(h.states.at(-1)).toBe('error'); expect(h.transport.saveProductPrice).toHaveBeenCalledOnce();
  });

  it('keeps website price conflicts separate and requires an explicit new-key rebase', async () => {
    const h = harness(); h.edit(); const write = h.transport.saveProductPrice; let blocked = true;
    h.transport.saveProductPrice = vi.fn(async (...args: Parameters<ShopPriceTransport['saveProductPrice']>) => {
      if (blocked) { h.product = { ...h.product, version: h.product.version + 1, content: { ...h.product.content, currentCents: 900, discountBps: 1000 } }; throw new CloudError('conflict', 409); }
      return write(...args);
    });
    await h.engine.run();
    const original = h.persisted.shopPricePending![0]!.request!;
    expect(h.persisted.shopPriceConflict).toBe(true); expect(h.persisted.conflict).toBe(false);
    expect(h.states.at(-1)).toBe('error');
    await h.engine.run(); expect(h.transport.saveProductPrice).toHaveBeenCalledTimes(1);
    await expect(h.engine.useCloud()).rejects.toThrow('先处理');
    blocked = false; await h.engine.resolveShopPrices('retry-local');
    const second = JSON.parse(vi.mocked(h.transport.saveProductPrice).mock.calls[1]![1]);
    expect(second.requestKey).not.toBe(original.requestKey); expect(second.version).toBeGreaterThan(original.version);
    expect(h.product.content.currentCents).toBe(750); expect(h.persisted.shopPriceConflict).toBe(false);
  });

  it('detects a changed website price before PUT and accepts it only on explicit keep-shop', async () => {
    const h = harness(); h.edit(); const productGet = h.transport.product;
    h.transport.product = vi.fn(async id => {
      h.product = { ...h.product, version: h.product.version + 1, content: { ...h.product.content, currentCents: 900, discountBps: 1000 } };
      return productGet(id);
    });
    await h.engine.run(); expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    expect(h.persisted.shopPriceConflict).toBe(true);
    h.transport.product = productGet;
    const image = randomUUID(); h.local.items['123456']!.shop.imageId = image;
    await h.engine.resolveShopPrices('keep-shop');
    expect(h.local.items['123456']!.shop).toMatchObject({ currentCents: 900, imageId: image });
    expect(h.local.items['123456']!.salePriceAmount).toBe(9);
    expect(h.server.inventory.items['123456']!.shop.currentCents).toBe(900);
    expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    expect(h.persisted.shopPricePending).toEqual([]);
  });

  it('keep-shop preserves a newer local price edit instead of replacing it', async () => {
    const h = harness(); h.edit(); h.transport.saveProductPrice = vi.fn(async () => { throw new CloudError('conflict', 409); });
    await h.engine.run(); h.edit(600);
    // Prevent the new queued edit's subsequent normal upload to inspect the resolution commit itself.
    const originalRun = h.engine.run.bind(h.engine);
    h.engine.run = async () => {};
    await h.engine.resolveShopPrices('keep-shop');
    expect(h.local.items['123456']!.shop.currentCents).toBe(600);
    expect(h.persisted.shopPricePending).toEqual([]);
    h.engine.run = originalRun;
  });

  it('keeps automatic dispatch blocked if accepting website prices changes the file but clearing the journal fails', async () => {
    const h = harness(); h.edit(); h.transport.saveProductPrice = vi.fn(async () => { throw new Error('network interrupted'); });
    await h.engine.run(); expect(h.persisted.shopPriceConflict).toBe(false);
    const save = h.adapter.save;
    h.adapter.save = async value => {
      if (!value.shopPricePending?.length) throw new Error('disk failed after local resolution');
      await save(value);
    };
    await expect(h.engine.resolveShopPrices('keep-shop')).rejects.toThrow('disk failed');
    expect(h.local.items['123456']!.shop.currentCents).toBe(1000);
    expect(h.persisted.shopPriceConflict).toBe(true);
    const calls = vi.mocked(h.transport.saveProductPrice).mock.calls.length;
    await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(h.transport.saveProductPrice).toHaveBeenCalledTimes(calls);
    expect(h.states.at(-1)).toBe('error');
  });

  it.each(['retry-local', 'keep-shop'] as const)('resolves a mixed queue with a conflicting registered item followed by an unbound registration candidate: %s', async choice => {
    const h = harness(); h.edit(); const write = h.transport.saveProductPrice;
    h.transport.saveProductPrice = vi.fn(async () => { throw new CloudError('conflict', 409); });
    await h.engine.run();
    const second: ShopProduct = { ...structuredClone(h.product), id: randomUUID(), sourceBarcode: '999999' };
    h.journal.shopPricePending!.push({ inventoryId: h.local.inventoryId, barcode: '999999', productId: '',
      base: shopPrice(second.content), desired: shopPrice(h.local.items['123456']!.shop) });
    await h.adapter.save(h.journal);
    h.transport.products = vi.fn(async () => [structuredClone(h.product), structuredClone(second)]);
    const getProduct = h.transport.product;
    h.transport.product = vi.fn(async id => {
      expect(id).not.toBe('');
      return id === second.id ? structuredClone(second) : getProduct(id);
    });
    h.transport.saveProductPrice = vi.fn(async (id, body) => id === second.id
      ? { ...second, version: second.version + 1, content: { ...second.content, ...JSON.parse(body).content } }
      : write(id, body));
    await h.engine.resolveShopPrices(choice);
    expect(h.persisted.shopPriceConflict).toBe(false); expect(h.persisted.shopPricePending).toEqual([]);
    expect(h.product.content.currentCents).toBe(choice === 'retry-local' ? 750 : 1000);
    expect(h.states.at(-1)).toBe('synced');
  });

  it('drops old product intents when their cloud book is deleted and recreated', async () => {
    const h = harness(); h.edit(); h.transport.product = vi.fn(async () => { throw new Error('offline'); });
    await h.engine.run(); const oldId = h.local.inventoryId;
    const request = h.adapter.request;
    h.adapter.request = async (method, id, body) => {
      if (id === oldId) throw new CloudError('deleted inventory', 410, false, true);
      return request(method, id, body);
    };
    await h.engine.run();
    expect(h.local.inventoryId).not.toBe(oldId);
    expect(h.persisted.shopPricePending).toEqual([]); expect(h.persisted.shopPriceConflict).toBe(false);
    expect(h.transport.saveProductPrice).not.toHaveBeenCalled(); expect(h.states.at(-1)).toBe('synced');
  });

  it('does not dispatch an old product queue after the bound local file is replaced', async () => {
    const h = harness(); h.edit(); h.transport.product = vi.fn(async () => { throw new Error('offline'); });
    await h.engine.run();
    const pending = structuredClone(h.persisted.shopPricePending);
    h.local = createInventory('Unrelated replacement');
    await h.engine.run();
    expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    expect(h.persisted.shopPricePending).toEqual(pending);
    expect(h.messages.at(-1)).toContain('本地文件已改变');
  });

  it('respects pause after stock acknowledgement and resumes the saved price queue later', async () => {
    const h = harness(); h.edit(); const request = h.adapter.request; let pause: Promise<void> | undefined;
    h.adapter.request = async (...args) => {
      const result = await request(...args); if (args[0] === 'PUT') pause = h.engine.pause(); return result;
    };
    await h.engine.run(); await pause;
    expect(h.persisted.shopPricePending).toHaveLength(1); expect(h.transport.saveProductPrice).not.toHaveBeenCalled();
    h.engine.resume(); await h.engine.run();
    expect(h.product.content.currentCents).toBe(750); expect(h.states.at(-1)).toBe('synced');
  });

  it('commits each completed product independently and retries only the unfinished product after partial failure', async () => {
    const h = harness();
    const one = structuredClone(h.product), two = { ...structuredClone(h.product), id: randomUUID(), sourceBarcode: '999999' };
    const products = new Map([[one.id, one], [two.id, two]]);
    const desired = { ...shopPrice(one.content), currentCents: 750, discountBps: 2500 };
    h.journal.shopPricePending = [...products.values()].map(product => ({ inventoryId: h.local.inventoryId,
      productId: product.id, barcode: product.sourceBarcode!, base: shopPrice(product.content), desired }));
    await h.adapter.save(h.journal);
    h.transport.product = vi.fn(async id => structuredClone(products.get(id)!));
    let blocked = true;
    h.transport.saveProductPrice = vi.fn(async (id, body) => {
      expect(h.persisted.shopPricePending?.[0]?.request?.body).toBe(body);
      if (id === two.id && blocked) throw new CloudError('permission temporarily unavailable', 403);
      const product = products.get(id)!;
      const updated = { ...product, content: { ...product.content, ...JSON.parse(body).content }, version: product.version + 1 };
      products.set(id, updated); return updated;
    });
    await h.engine.run();
    expect(h.persisted.shopPricePending).toHaveLength(1); expect(h.persisted.shopPricePending![0]!.productId).toBe(two.id);
    const retryBody = h.persisted.shopPricePending![0]!.request!.body;
    blocked = false; await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(vi.mocked(h.transport.saveProductPrice).mock.calls.map(args => args[0])).toEqual([one.id, two.id, two.id]);
    expect(vi.mocked(h.transport.saveProductPrice).mock.calls[2]![1]).toBe(retryBody);
    expect(h.persisted.shopPricePending).toEqual([]); expect(h.states.at(-1)).toBe('synced');
  });

  it('keeps old service/journal records compatible while preparing only actual price edits', async () => {
    const h = harness(); delete h.server.shopRegisteredBarcodes;
    expect(await prepareShopPrices(h.local, 1, h.transport)).toEqual({ intents: [], candidates: [] });
    h.edit(); expect((await prepareShopPrices(h.local, 1, h.transport)).intents).toHaveLength(1);
  });
});
