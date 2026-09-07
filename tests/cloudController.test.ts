import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudController } from '../src/main/cloudController';
import { CloudClient } from '../src/main/cloudClient';
import { JournalStore } from '../src/main/cloudStore';
import { createInventory } from '../src/shared/inventoryLogic';
import { CloudAccount, InventoryDocument } from '../src/shared/types';

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
