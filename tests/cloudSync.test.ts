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
