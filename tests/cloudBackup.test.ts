import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupCloudInventory, readInventoryFile, writeInventoryFile } from '../src/main/fileStore';
import { createInventory, submitBarcode, updateNickname } from '../src/shared/inventoryLogic';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('cloud copy backup before local overwrite', () => {
  it('preserves an independently reopenable cloud snapshot beside the untouched local file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'amane-cloud-backup-')); directories.push(directory);
    const file = path.join(directory, '库存.json');
    const local = submitBarcode(createInventory('本地库存'), '123456', 'in').inventory;
    await writeInventoryFile(file, local); const before = await readFile(file, 'utf8');
    const cloud = updateNickname(local, '123456', '云端名称');
    cloud.cloudLink = { server: 'https://api.amaneacg.space', accountId: 'synthetic-account', version: 7, baseHash: 'synthetic-hash' };
    const record = { id: local.inventoryId, version: 7, inventory: cloud, updatedAt: new Date().toISOString() };
    const backup = await backupCloudInventory(file, record);
    expect(path.dirname(backup)).toBe(directory);
    expect(path.basename(backup)).toMatch(/^库存\.json\.cloud-v7\.backup-.*\.json$/);
    const reopened = await readInventoryFile(backup);
    expect(reopened.inventoryId).toBe(local.inventoryId);
    expect(reopened.items['123456']!.nickname).toBe('云端名称');
    expect(reopened.transactions).toEqual(local.transactions);
    expect(JSON.parse(await readFile(backup, 'utf8')).cloudLink).toBeUndefined();
    expect(cloud.cloudLink).toBeDefined();
    expect(await readFile(file, 'utf8')).toBe(before);
    const second = await backupCloudInventory(file, record);
    expect(second).not.toBe(backup); expect(await readFile(second, 'utf8')).toBe(await readFile(backup, 'utf8'));
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not write a backup for a mismatched cloud identity', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'amane-cloud-backup-')); directories.push(directory);
    const inventory = createInventory('Synthetic');
    await expect(backupCloudInventory(path.join(directory, 'stock.json'), {
      id: createInventory('Other').inventoryId, version: 2, inventory, updatedAt: new Date().toISOString()
    })).rejects.toThrow('标识无效');
    expect(await readdir(directory)).toEqual([]);
  });
});
