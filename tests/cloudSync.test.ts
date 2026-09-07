import { describe, expect, it } from 'vitest';
import { createInventory, submitBarcode, updateNickname } from '../src/shared/inventoryLogic';
import { InventoryFile, StockRecord } from '../src/shared/types';
import { CloudError, inventoryHash, SyncAdapter, SyncEngine, SyncJournal } from '../src/main/cloudSync';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(version = 0) {
  let local = submitBarcode(createInventory('Synthetic test inventory'), '123456', 'in').inventory;
  const journal: SyncJournal = { accountId: 'account-a', filePath: 'C:/synthetic/a.json', inventoryId: local.inventoryId, version, baseHash: version ? inventoryHash(local) : '', pending: null, conflict: false, lastSuccess: null };
  let persisted = structuredClone(journal), backups = 0;
  const calls: { method: string; body?: string }[] = [], states: string[] = [];
  const remote = (inventory = local, currentVersion = 1): StockRecord => ({ id: inventory.inventoryId, inventory: structuredClone(inventory), version: currentVersion, updatedAt: new Date().toISOString() });
  let handler: SyncAdapter['request'] = async (_method, _id, body) => remote(body ? JSON.parse(body).inventory : local, journal.version + 1);
  const adapter: SyncAdapter = {
    server: 'https://admin.invalid', read: async () => structuredClone(local),
    change: async (_path, id, update, backup) => { if (id !== local.inventoryId) throw new Error('binding mismatch'); if (backup) backups++; local = update(local); },
    save: async j => { persisted = structuredClone(j); },
    request: async (method, id, body) => { calls.push({ method, body }); return handler(method, id, body); },
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
    expect(h.calls).toHaveLength(1); expect(h.persisted.conflict).toBe(true); expect(h.persisted.pending).not.toBeNull();
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
