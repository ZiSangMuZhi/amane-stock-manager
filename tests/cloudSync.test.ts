import { describe, expect, it } from 'vitest';
import { createInventory, submitBarcode, updateNickname } from '../src/shared/inventoryLogic';
import { InventoryFile, StockRecord } from '../src/shared/types';
import { CloudError, inventoryHash, SyncAdapter, SyncEngine, SyncJournal } from '../src/main/cloudSync';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(version = 0) {
  let local = submitBarcode(createInventory('Synthetic test inventory'), '123456', 'in').inventory;
  const journal: SyncJournal = { accountId: 'account-a', filePath: 'C:/synthetic/a.json', inventoryId: local.inventoryId, version, baseHash: version ? inventoryHash(local) : '', pending: null, conflict: false, lastSuccess: null };
  let persisted = structuredClone(journal), backups = 0;
  const calls: { method: string; id: string; body?: string }[] = [], states: string[] = [];
  const remote = (inventory = local, currentVersion = 1): StockRecord => ({ id: inventory.inventoryId, inventory: structuredClone(inventory), version: currentVersion, updatedAt: new Date().toISOString() });
  let handler: SyncAdapter['request'] = async (_method, _id, body) => remote(body ? JSON.parse(body).inventory : local, journal.version + 1);
  const adapter: SyncAdapter = {
    server: 'https://admin.invalid', read: async () => structuredClone(local),
    change: async (_path, id, update, backup) => { if (id !== local.inventoryId) throw new Error('binding mismatch'); if (backup) backups++; local = update(local); },
    save: async j => { persisted = structuredClone(j); },
    request: async (method, id, body) => { calls.push({ method, id, body }); return handler(method, id, body); },
    report: state => { states.push(state); }
  };
  const engine = new SyncEngine(journal, adapter);
  return { journal, adapter, engine, calls, states, remote,
    get local() { return local; }, set local(value: InventoryFile) { local = value; },
    get persisted() { return persisted; }, get backups() { return backups; },
    handle: (value: SyncAdapter['request']) => { handler = value; }
  };
}

describe('durable single-flight synchronization (synthetic documents only)', () => {
  it('persists exact wire payload before sending and replays it after a lost response and restart', async () => {
    const h = harness(); let server: StockRecord | undefined;
    h.handle(async (_method, _id, body) => {
      expect(h.persisted.pending?.body).toBe(body);
      server = h.remote(JSON.parse(body!).inventory);
      throw new Error('connection lost after server commit');
    });
    await h.engine.run();
    expect(h.states.at(-1)).toBe('offline');
    const original = h.calls[0]!.body;
    const restarted = new SyncEngine(h.persisted, h.adapter);
    h.handle(async () => server!);
    await restarted.run();
    expect(h.calls[1]!.body).toBe(original);
    expect(h.persisted.pending).toBeNull();
    expect(h.local.items['123456']!.quantityOnHand).toBe(1);
  });

  it('keeps edits made while uploading and sends them in a second versioned snapshot', async () => {
    const h = harness(), gate = deferred<StockRecord>(), entered = deferred<void>();
    h.handle(async (_m, _id, body) => {
      if (h.calls.length === 1) { entered.resolve(); return gate.promise; }
      return h.remote(JSON.parse(body!).inventory, 2);
    });
    const flight = h.engine.run(); await entered.promise;
    const first = JSON.parse(h.calls[0]!.body!).inventory;
    h.local = submitBarcode(h.local, '123456', 'in').inventory;
    gate.resolve(h.remote(first)); await flight;
    expect(h.local.items['123456']!.quantityOnHand).toBe(2);
    expect(h.calls).toHaveLength(2);
    expect(JSON.parse(h.calls[1]!.body!).version).toBe(1);
    expect(JSON.parse(h.calls[1]!.body!).inventory.items['123456'].quantityOnHand).toBe(2);
  });

  it('runs one network transfer even with repeated retry calls', async () => {
    const h = harness(), gate = deferred<StockRecord>(), entered = deferred<void>();
    h.handle(async () => { entered.resolve(); return gate.promise; });
    const one = h.engine.run(), two = h.engine.run();
    expect(one).toBe(two); await entered.promise;
    expect(h.calls).toHaveLength(1);
    gate.resolve(h.remote()); await one;
  });

  it('leaves denied and unavailable requests durable for retry', async () => {
    for (const status of [401, 403, 429, 500]) {
      const h = harness(); h.handle(async () => { throw new CloudError('denied', status); });
      await h.engine.run();
      expect(h.persisted.pending?.body).toBe(h.calls[0]!.body);
      expect(h.local.items['123456']!.quantityOnHand).toBe(1);
      expect(h.states.at(-1)).toBe(status === 401 ? 'expired' : 'error');
    }
  });

  it('permits a corrected snapshot after a definitive validation rejection', async () => {
    const h = harness(); h.handle(async () => { throw new CloudError('invalid snapshot', 400, true); });
    await h.engine.run(); expect(h.persisted.pending).toBeNull();
    h.local = updateNickname(h.local, '123456', 'corrected');
    h.handle(async (_m, _id, body) => h.remote(JSON.parse(body!).inventory)); await h.engine.run();
    expect(JSON.parse(h.calls[1]!.body!).requestKey).not.toBe(JSON.parse(h.calls[0]!.body!).requestKey);
    expect(h.local.items['123456']!.nickname).toBe('corrected');
  });

  it('detects a local edit inside the queued pull commit before advancing its base', async () => {
    const h = harness(1), base = h.journal.baseHash;
    const change = h.adapter.change;
    h.adapter.change = async (...args) => { h.local = updateNickname(h.local, '123456', 'queued local edit'); await change(...args); };
    h.handle(async () => h.remote(updateNickname(h.local, '123456', 'cloud edit'), 2));
    await h.engine.run();
    expect(h.journal.baseHash).toBe(base); expect(h.journal.version).toBe(1);
    expect(h.local.items['123456']!.nickname).toBe('queued local edit'); expect(h.journal.conflict).toBe(true);
  });

  it('persists version conflicts and never automatically retries a conflicting snapshot', async () => {
    const h = harness(); h.handle(async () => { throw new CloudError('conflict', 409); });
    await h.engine.run(); const restarted = new SyncEngine(h.persisted, h.adapter); await restarted.run();
    expect(h.calls.map(call => call.method)).toEqual(['POST', 'GET']); expect(h.persisted.conflict).toBe(true); expect(h.persisted.pending).not.toBeNull();
  });

  it('backs up before the explicit use-cloud conflict choice', async () => {
    const h = harness(1); h.journal.conflict = true;
    const remote = updateNickname(h.local, '123456', 'cloud name');
    h.handle(async () => h.remote(remote, 3));
    await h.engine.useCloud();
    expect(h.backups).toBe(1); expect(h.local.items['123456']!.nickname).toBe('cloud name');
    expect(h.persisted.version).toBe(3); expect(h.persisted.conflict).toBe(false);
  });

  it('backs up a clean local copy before pulling a newer cloud version', async () => {
    const h = harness(1), remote = updateNickname(h.local, '123456', 'cloud');
    h.handle(async () => h.remote(remote, 2)); await h.engine.run();
    expect(h.backups).toBe(1); expect(h.local.items['123456']!.nickname).toBe('cloud');
    expect(h.calls[0]!.method).toBe('GET');
  });

  it('does not advance the base or lose edits when both sides change during a download', async () => {
    const h = harness(1), gate = deferred<StockRecord>(), entered = deferred<void>();
    const oldBase = h.journal.baseHash;
    h.handle(async () => { entered.resolve(); return gate.promise; });
    const flight = h.engine.run(); await entered.promise;
    h.local = updateNickname(h.local, '123456', 'local edit');
    gate.resolve(h.remote(updateNickname(h.local, '123456', 'remote edit'), 2)); await flight;
    expect(h.local.items['123456']!.nickname).toBe('local edit');
    expect(h.journal.baseHash).toBe(oldBase); expect(h.journal.conflict).toBe(true);
  });

  it('refuses a replaced local file and a mismatched server response', async () => {
    const h = harness(); h.local = createInventory('different file'); await h.engine.run(); expect(h.calls).toHaveLength(0);
    const h2 = harness(); h2.handle(async () => h2.remote(createInventory('wrong book'))); await h2.engine.run();
    expect(h2.persisted.pending).not.toBeNull(); expect(h2.local.inventoryName).toBe('Synthetic test inventory');
  });

  it('retains an ambiguous old request if the bound local path is replaced with a different inventory', async () => {
    const h = harness(); h.handle(async () => { throw new Error('response lost'); }); await h.engine.run();
    const pending = structuredClone(h.persisted.pending); h.local = createInventory('replaced path');
    await h.engine.run(); expect(h.persisted.pending).toEqual(pending); expect(h.calls).toHaveLength(1);
  });

  it('pause waits for in-flight acknowledgement before account/file changes proceed', async () => {
    const h = harness(), gate = deferred<StockRecord>(), entered = deferred<void>(); let paused = false;
    h.handle(async () => { entered.resolve(); return gate.promise; });
    const flight = h.engine.run(); await entered.promise;
    const pause = h.engine.pause().then(() => { paused = true; });
    await Promise.resolve(); expect(paused).toBe(false);
    gate.resolve(h.remote()); await Promise.all([flight, pause]);
    await h.engine.run(); expect(h.calls).toHaveLength(1);
  });
});

describe('automatic upload when the connected cloud inventory was deleted', () => {
  const missing = (status = 410) => new CloudError('stock absent', status, false, true);

  it.each([404, 410])('backs up and recreates a clean local file after an explicit GET %i', async status => {
    const h = harness(3), before = structuredClone(h.local), oldId = before.inventoryId;
    h.local = { ...h.local, cloudLink: { server: h.adapter.server, accountId: 'account-a', version: 3, baseHash: h.journal.baseHash } };
    h.handle(async (method, id, body) => {
      if (id === oldId) throw missing(status);
      expect(method).toBe('POST'); expect(h.persisted.pending?.body).toBe(body);
      expect(h.persisted.inventoryId).toBe(id);
      return h.remote(JSON.parse(body!).inventory);
    });
    await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'POST']);
    expect(h.local.inventoryId).not.toBe(oldId); expect(h.backups).toBe(1);
    expect(h.local.inventoryName).toBe(before.inventoryName);
    expect(h.local.items).toEqual(before.items); expect(h.local.transactions).toEqual(before.transactions);
    expect(JSON.parse(h.calls[1]!.body!).inventory.cloudLink).toBeUndefined();
    expect(JSON.parse(h.calls[1]!.body!).version).toBeUndefined();
    expect(h.persisted).toMatchObject({ inventoryId: h.local.inventoryId, version: 1, pending: null, conflict: false });
    expect(h.states.at(-1)).toBe('synced');
  });

  it('uploads the latest edits after a PUT fails, then continues versioned synchronization', async () => {
    const h = harness(2), oldId = h.local.inventoryId;
    h.local = submitBarcode(h.local, '123456', 'in').inventory;
    h.handle(async (method, id, body) => {
      if (id === oldId) {
        if (method === 'PUT') h.local = updateNickname(h.local, '123456', 'edited during request');
        throw missing();
      }
      return h.remote(JSON.parse(body!).inventory, method === 'POST' ? 1 : 2);
    });
    await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['PUT', 'GET', 'POST']);
    const created = JSON.parse(h.calls[2]!.body!).inventory;
    expect(created.items['123456']).toMatchObject({ quantityOnHand: 2, nickname: 'edited during request' });
    expect(created.transactions).toEqual(h.local.transactions);
    h.local = submitBarcode(h.local, '123456', 'in').inventory;
    await h.engine.run();
    expect(h.calls.at(-1)?.method).toBe('PUT'); expect(JSON.parse(h.calls.at(-1)!.body!).version).toBe(1);
    expect(h.backups).toBe(1); expect(h.local.items['123456']!.quantityOnHand).toBe(3);
  });

  it('replays the exact new POST after its response is lost and the engine restarts', async () => {
    const h = harness(1), oldId = h.local.inventoryId; let committed: StockRecord | undefined;
    h.handle(async (_method, id, body) => {
      if (id === oldId) throw missing();
      committed = h.remote(JSON.parse(body!).inventory);
      throw new Error('lost after new book committed');
    });
    await h.engine.run();
    const create = h.calls[1]!, newId = h.local.inventoryId;
    expect(h.persisted.pending?.body).toBe(create.body);
    h.local = submitBarcode(h.local, '123456', 'in').inventory;
    const restarted = new SyncEngine(h.persisted, h.adapter);
    h.handle(async (method, id, body) => {
      expect(id).toBe(newId);
      if (method === 'POST') { expect(body).toBe(create.body); return committed!; }
      return h.remote(JSON.parse(body!).inventory, 2);
    });
    await restarted.run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST', 'PUT']);
    expect(h.local.inventoryId).toBe(newId); expect(h.backups).toBe(1);
    expect(h.persisted.version).toBe(2); expect(h.persisted.pending).toBeNull();
  });

  it.each(['before-local-write', 'after-local-write'])('resumes the same durable replacement ID after a crash %s', async stage => {
    const h = harness(1), oldId = h.local.inventoryId, originalSave = h.adapter.save, originalChange = h.adapter.change;
    h.handle(async (_method, id, body) => { if (id === oldId) throw missing(); return h.remote(JSON.parse(body!).inventory); });
    if (stage === 'before-local-write') h.adapter.change = async () => { throw new Error('local disk unavailable'); };
    else h.adapter.save = async value => { if (!value.replacement && value.inventoryId !== oldId) throw new Error('journal disk unavailable'); await originalSave(value); };
    await h.engine.run();
    const intendedId = h.persisted.replacement!.inventoryId;
    expect(h.calls.map(call => call.method)).toEqual(['GET']);
    expect(h.local.inventoryId).toBe(stage === 'before-local-write' ? oldId : intendedId);
    h.adapter.change = originalChange; h.adapter.save = originalSave;
    const restarted = new SyncEngine(h.persisted, h.adapter); await restarted.run();
    expect(h.local.inventoryId).toBe(intendedId); expect(h.persisted.replacement).toBeUndefined();
    expect(h.calls.at(-1)?.id).toBe(intendedId); expect(h.backups).toBe(1);
    expect(h.states.at(-1)).toBe('synced');
  });

  it('does not change the local identity when saving the recovery intent fails', async () => {
    const h = harness(1), before = structuredClone(h.local);
    h.handle(async () => { throw missing(); }); h.adapter.save = async () => { throw new Error('journal unavailable'); };
    await h.engine.run();
    expect(h.local).toEqual(before); expect(h.journal.replacement).toBeUndefined(); expect(h.backups).toBe(0);
  });

  it('persists the same pending create before retrying after a failed journal write', async () => {
    const h = harness(1), oldId = h.local.inventoryId, save = h.adapter.save;
    let rejectPendingSave = true;
    h.adapter.save = async value => {
      if (value.pending?.method === 'POST' && rejectPendingSave) throw new Error('disk full before send');
      await save(value);
    };
    h.handle(async (_method, id, body) => {
      if (id === oldId) throw missing();
      expect(h.persisted.pending?.body).toBe(body);
      return h.remote(JSON.parse(body!).inventory);
    });
    await h.engine.run();
    const pending = structuredClone(h.journal.pending);
    expect(pending?.method).toBe('POST'); expect(h.persisted.pending).toBeNull(); expect(h.calls).toHaveLength(1);
    rejectPendingSave = false; await h.engine.run();
    expect(h.calls[1]?.body).toBe(pending?.body); expect(h.states.at(-1)).toBe('synced'); expect(h.backups).toBe(1);
  });

  it('checks whether a create conflict refers to a deleted book before uploading under a new ID', async () => {
    const h = harness(), oldId = h.local.inventoryId;
    h.handle(async (method, id, body) => {
      if (id === oldId) { if (method === 'POST') throw new CloudError('already exists', 409); throw missing(); }
      return h.remote(JSON.parse(body!).inventory);
    });
    await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['POST', 'GET', 'POST']);
    expect(h.persisted.conflict).toBe(false); expect(h.states.at(-1)).toBe('synced');
  });

  it('keeps an old tombstoned request as a conflict if the same cloud ID is active again', async () => {
    const h = harness(2), oldId = h.local.inventoryId;
    h.local = updateNickname(h.local, '123456', 'local edit');
    h.handle(async method => { if (method === 'PUT') throw missing(); return h.remote(h.local, 1); });
    await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['PUT', 'GET']);
    expect(h.local.inventoryId).toBe(oldId); expect(h.backups).toBe(0); expect(h.persisted.conflict).toBe(true);
  });

  it.each([401, 403, 404, 410, 429, 500])('never reallocates an ID for unconfirmed HTTP %i errors', async status => {
    const h = harness(1), oldId = h.local.inventoryId;
    h.handle(async () => { throw new CloudError('unconfirmed response', status); }); await h.engine.run();
    expect(h.local.inventoryId).toBe(oldId); expect(h.calls).toHaveLength(1); expect(h.backups).toBe(0);
  });

  it('keeps the pending request when confirming a write failure is blocked by network loss', async () => {
    const h = harness(1), oldId = h.local.inventoryId; h.local = updateNickname(h.local, '123456', 'edit');
    h.handle(async method => { if (method === 'PUT') throw missing(); throw new Error('offline probe'); }); await h.engine.run();
    expect(h.local.inventoryId).toBe(oldId); expect(h.persisted.pending?.body).toBe(h.calls[0]!.body);
    expect(h.states.at(-1)).toBe('offline'); expect(h.backups).toBe(0);
  });

  it.each([401, 403, 404])('preserves the old request when the confirming GET fails with unconfirmed HTTP %i', async status => {
    const h = harness(1), oldId = h.local.inventoryId; h.local = updateNickname(h.local, '123456', 'edit');
    h.handle(async method => { if (method === 'PUT') throw missing(); throw new CloudError('probe denied', status); }); await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['PUT', 'GET']); expect(h.local.inventoryId).toBe(oldId);
    expect(h.persisted.pending?.body).toBe(h.calls[0]!.body); expect(h.backups).toBe(0);
    expect(h.states.at(-1)).toBe(status === 401 ? 'expired' : 'error');
  });

  it('refuses to complete a saved replacement over a third inventory placed at the same path', async () => {
    const h = harness(1); h.journal.replacement = { inventoryId: createInventory('intended').inventoryId };
    h.local = createInventory('unrelated replacement'); const before = structuredClone(h.local);
    await h.engine.run();
    expect(h.local).toEqual(before); expect(h.calls).toHaveLength(0); expect(h.backups).toBe(0);
  });

  it('limits recovery to one new identity per run if the replacement is immediately deleted too', async () => {
    const h = harness(1); h.handle(async () => { throw missing(); }); await h.engine.run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'POST']); expect(h.backups).toBe(1);
    expect(h.persisted.pending?.method).toBe('POST'); expect(h.states.at(-1)).toBe('error');
  });
});

describe('explicit local overwrite of a conflicting cloud inventory', () => {
  async function conflict() {
    const h = harness(2);
    h.local = updateNickname(h.local, '123456', 'chosen local name');
    const requestKey = '511d3906-bfd9-4dbe-a78c-ff983a920c39';
    h.journal.pending = { method: 'PUT', version: 2, requestKey, hash: inventoryHash(h.local), body: JSON.stringify({ inventory: h.local, version: 2, requestKey }) };
    h.journal.conflict = true;
    await h.adapter.save(h.journal);
    const remoteInventory = submitBarcode(updateNickname(h.local, '123456', 'cloud name'), '987654', 'in').inventory;
    const latest = h.remote(remoteInventory, 7);
    const backups: StockRecord[] = [];
    h.adapter.backupRemote = async (filePath, record) => { expect(filePath).toBe(h.journal.filePath); backups.push(structuredClone(record)); };
    h.handle(async (method, _id, body) => method === 'GET' ? structuredClone(latest) : h.remote(JSON.parse(body!).inventory, 8));
    return { h, latest, backups };
  }

  it('backs up the latest cloud record before durably replacing the old request and overwrites the same ID in full', async () => {
    const { h, latest, backups } = await conflict();
    const before = structuredClone(h.journal), selected = structuredClone(h.local), order: string[] = [];
    const save = h.adapter.save, backup = h.adapter.backupRemote!;
    h.adapter.backupRemote = async (...args) => { order.push('backup'); expect(h.journal).toEqual(before); await backup(...args); };
    h.adapter.save = async value => { if (value.pending?.overwrite) order.push('save'); await save(value); };
    h.handle(async (method, id, body) => {
      order.push(method);
      if (method === 'GET') return structuredClone(latest);
      expect(backups).toEqual([latest]); expect(h.persisted.pending?.body).toBe(body); expect(h.persisted.conflict).toBe(false);
      expect(h.persisted.pending).toMatchObject({ method: 'PUT', version: 7, overwrite: true });
      expect(id).toBe(selected.inventoryId);
      const payload = JSON.parse(body!);
      expect(payload.inventory).toEqual(selected); expect(payload.inventory.items).not.toHaveProperty('987654');
      expect(payload.inventory.transactions).toEqual(selected.transactions);
      expect(payload.version).toBe(7); expect(payload.requestKey).not.toBe(before.pending!.requestKey); expect(payload.overwrite).toBeUndefined();
      return h.remote(payload.inventory, 8);
    });
    await h.engine.useLocal();
    expect(order).toEqual(['GET', 'backup', 'save', 'save', 'PUT']);
    expect(h.local.inventoryId).toBe(selected.inventoryId); expect(h.local.inventoryName).toBe(selected.inventoryName);
    expect(h.local.items).toEqual(selected.items); expect(h.local.transactions).toEqual(selected.transactions);
    expect(h.persisted).toMatchObject({ inventoryId: selected.inventoryId, version: 8, conflict: false, pending: null });
    expect(h.states.at(-1)).toBe('synced'); expect(h.backups).toBe(0);
  });

  it('requires an existing inventory conflict', async () => {
    const h = harness(2);
    await expect(h.engine.useLocal()).rejects.toMatchObject({ status: 400 }); expect(h.calls).toHaveLength(0);
  });

  it.each(['queue', 'price-conflict'] as const)('does not replace unresolved shop prices (%s)', async pending => {
    const { h, backups } = await conflict();
    if (pending === 'price-conflict') h.journal.shopPriceConflict = true;
    else h.journal.shopPricePending = [{ inventoryId: h.local.inventoryId, barcode: '123456', productId: 'registered-product', base: { originalCents: 1000, currentCents: 1000, discountBps: 0, priceSource: 'current' }, desired: { originalCents: 1000, currentCents: 800, discountBps: 2000, priceSource: 'current' } }];
    await h.adapter.save(h.journal); const before = structuredClone(h.journal);
    await expect(h.engine.useLocal()).rejects.toThrow('商店价格');
    expect(h.journal).toEqual(before); expect(h.calls).toHaveLength(0); expect(backups).toHaveLength(0);
  });

  it.each(['unavailable', 'backup-failed', 'save-failed'] as const)('keeps the old conflict and pending bytes when preparation cannot persist (%s)', async failure => {
    const { h, backups } = await conflict(); const before = structuredClone(h.journal), save = h.adapter.save;
    if (failure === 'unavailable') h.adapter.backupRemote = undefined;
    if (failure === 'backup-failed') h.adapter.backupRemote = async () => { throw new Error('backup disk full'); };
    if (failure === 'save-failed') h.adapter.save = async value => { if (value.pending?.overwrite) throw new Error('journal disk full'); await save(value); };
    await expect(h.engine.useLocal()).rejects.toThrow();
    expect(h.journal).toEqual(before); expect(h.persisted).toEqual(before);
    expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    expect(backups).toHaveLength(failure === 'save-failed' ? 1 : 0);
    const requests = h.calls.length; await h.engine.run();
    expect(h.calls).toHaveLength(requests); expect(h.states.at(-1)).toBe('conflict');
  });

  it('rejects an invalid local snapshot without touching the cloud', async () => {
    const { h, backups } = await conflict(), before = structuredClone(h.journal);
    h.local.items['123456']!.quantityOnHand = -1;
    await expect(h.engine.useLocal()).rejects.toMatchObject({ status: 400 });
    expect(h.journal).toEqual(before); expect(h.calls).toHaveLength(0); expect(backups).toHaveLength(0);
  });

  it.each(['identity', 'version', 'content'] as const)('validates the cloud record before backup or overwrite (%s)', async invalid => {
    const { h, latest, backups } = await conflict(), before = structuredClone(h.journal);
    if (invalid === 'identity') latest.id = createInventory('other').inventoryId;
    if (invalid === 'version') latest.version = 0;
    if (invalid === 'content') latest.inventory.items['123456']!.quantityOnHand = -1;
    h.handle(async () => latest);
    await expect(h.engine.useLocal()).rejects.toMatchObject({ status: 502 });
    expect(h.journal).toEqual(before); expect(h.calls.map(call => call.method)).toEqual(['GET']); expect(backups).toHaveLength(0);
  });

  it.each(['during-get', 'during-backup'] as const)('retains edits made while preparing and requires another choice (%s)', async when => {
    const { h, latest, backups } = await conflict(), before = structuredClone(h.journal), backup = h.adapter.backupRemote!;
    if (when === 'during-get') h.handle(async () => { h.local = updateNickname(h.local, '123456', 'new local edit'); return latest; });
    else h.adapter.backupRemote = async (...args) => { await backup(...args); h.local = updateNickname(h.local, '123456', 'new local edit'); };
    await expect(h.engine.useLocal()).rejects.toMatchObject({ status: 409 });
    expect(h.journal).toEqual(before); expect(h.persisted).toEqual(before); expect(backups).toEqual([latest]);
    expect(h.local.items['123456']!.nickname).toBe('new local edit');
    expect(h.calls.map(call => call.method)).toEqual(['GET']); await h.engine.run(); expect(h.calls).toHaveLength(1);
  });

  it('stops on a renewed 409 until another explicit choice, fresh backup and request key', async () => {
    const { h, latest, backups } = await conflict();
    h.handle(async method => { if (method === 'GET') return latest; throw new CloudError('latest version changed again', 409); });
    await h.engine.useLocal();
    const attempted = structuredClone(h.persisted.pending!);
    expect(attempted).toMatchObject({ overwrite: true, version: 7 }); expect(h.persisted.conflict).toBe(true);
    await h.engine.run(); expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT']); expect(backups).toHaveLength(1);
    latest.version = 9;
    h.handle(async (method, _id, body) => method === 'GET' ? latest : h.remote(JSON.parse(body!).inventory, 10));
    await h.engine.useLocal();
    const second = JSON.parse(h.calls.at(-1)!.body!);
    expect(second.version).toBe(9); expect(second.requestKey).not.toBe(attempted.requestKey);
    expect(backups).toHaveLength(2); expect(h.persisted.conflict).toBe(false); expect(h.persisted.version).toBe(10);
  });

  it.each([false, true])('replays exactly the durable overwrite after restart when a response is lost (committed=%s)', async committed => {
    const { h, latest, backups } = await conflict(); let acknowledged: StockRecord | undefined;
    h.handle(async (method, _id, body) => {
      if (method === 'GET') return latest;
      if (committed) acknowledged = h.remote(JSON.parse(body!).inventory, 8);
      throw new Error('synthetic connection lost');
    });
    await h.engine.useLocal(); const pending = structuredClone(h.persisted.pending!);
    expect(pending.overwrite).toBe(true); expect(h.persisted.conflict).toBe(false); expect(h.states.at(-1)).toBe('offline');
    const restarted = new SyncEngine(structuredClone(h.persisted), h.adapter);
    h.handle(async (method, id, body) => { expect(method).toBe('PUT'); expect(id).toBe(h.local.inventoryId); expect(body).toBe(pending.body); return acknowledged ?? h.remote(JSON.parse(body!).inventory, 8); });
    await restarted.run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'PUT']); expect(backups).toHaveLength(1);
    expect(h.persisted.pending).toBeNull(); expect(h.states.at(-1)).toBe('synced');
  });

  it('keeps newer local edits during the overwrite and queues them against its acknowledged version', async () => {
    const { h, latest } = await conflict(), gate = deferred<StockRecord>(), entered = deferred<void>();
    let writes = 0;
    h.handle(async (method, _id, body) => {
      if (method === 'GET') return latest;
      if (++writes === 1) { entered.resolve(); return gate.promise; }
      return h.remote(JSON.parse(body!).inventory, 9);
    });
    const flight = h.engine.useLocal(); await entered.promise;
    const first = JSON.parse(h.calls[1]!.body!);
    h.local = updateNickname(h.local, '123456', 'edited during overwrite');
    gate.resolve(h.remote(first.inventory, 8)); await flight;
    const second = JSON.parse(h.calls[2]!.body!);
    expect(first.inventory.items['123456'].nickname).toBe('chosen local name');
    expect(second.version).toBe(8); expect(second.inventory.items['123456'].nickname).toBe('edited during overwrite');
    expect(second.requestKey).not.toBe(first.requestKey); expect(h.local.items['123456']!.nickname).toBe('edited during overwrite');
    expect(h.local.inventoryId).toBe(latest.id); expect(h.calls.every(call => call.id === latest.id)).toBe(true);
  });

  it.each([404, 410])('does not recreate an already-deleted cloud book while preparing (%i)', async status => {
    const { h, backups } = await conflict(), before = structuredClone(h.journal), id = h.local.inventoryId;
    h.handle(async () => { throw new CloudError('stock missing', status, false, true); });
    await expect(h.engine.useLocal()).rejects.toMatchObject({ status: 409 });
    expect(h.journal).toEqual(before); expect(h.local.inventoryId).toBe(id); expect(backups).toHaveLength(0);
    expect(h.calls.map(call => call.method)).toEqual(['GET']);
  });

  it.each([404, 410])('keeps the same ID and stops instead of POST when the cloud is deleted after backup (%i)', async status => {
    const { h, latest } = await conflict(), id = h.local.inventoryId;
    h.handle(async method => { if (method === 'GET') return latest; throw new CloudError('stock missing', status, false, true); });
    await h.engine.useLocal();
    expect(h.local.inventoryId).toBe(id); expect(h.persisted.inventoryId).toBe(id); expect(h.persisted.replacement).toBeUndefined();
    expect(h.persisted.pending?.overwrite).toBe(true); expect(h.persisted.conflict).toBe(true); expect(h.states.at(-1)).toBe('conflict');
    await new SyncEngine(structuredClone(h.persisted), h.adapter).run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT']);
  });

  it('retains the no-recreation guard when replaying an offline overwrite from disk', async () => {
    const { h, latest } = await conflict();
    h.handle(async method => { if (method === 'GET') return latest; throw new Error('offline before response'); });
    await h.engine.useLocal();
    const saved = structuredClone(h.persisted), id = saved.inventoryId;
    h.handle(async () => { throw new CloudError('stock deleted after shutdown', 410, false, true); });
    await new SyncEngine(saved, h.adapter).run();
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'PUT']);
    expect(h.persisted).toMatchObject({ inventoryId: id, conflict: true, pending: { overwrite: true } });
    expect(h.local.inventoryId).toBe(id); expect(h.persisted.replacement).toBeUndefined();
  });

  it.each([400, 413])('requires another explicit choice after definitive overwrite rejection (%i)', async status => {
    const { h, latest } = await conflict();
    h.handle(async method => { if (method === 'GET') return latest; throw new CloudError('overwrite rejected', status, true); });
    await h.engine.useLocal(); const pending = structuredClone(h.persisted.pending);
    expect(h.persisted.conflict).toBe(true); expect(pending?.overwrite).toBe(true);
    h.local = updateNickname(h.local, '123456', 'corrected'); await h.engine.run();
    expect(h.persisted.pending).toEqual(pending); expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT']);
  });
});
