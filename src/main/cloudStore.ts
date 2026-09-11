import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncJournal, samePath } from './cloudSync';

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}

export async function atomicWrite(filePath: string, bytes: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, filePath);
}

export class TokenVault {
  constructor(private readonly filePath: string, private readonly encryption: EncryptionProvider) {}
  get available(): boolean {
    try { return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  }
  async load(): Promise<string | null> {
    if (!this.available) return null;
    try { return this.encryption.decryptString(await fs.readFile(this.filePath)); } catch { return null; }
  }
  async save(cookies: string): Promise<void> {
    if (!this.available) { await this.clear(); return; }
    // Failure never falls back to plaintext. No password is accepted by this store.
    await atomicWrite(this.filePath, this.encryption.encryptString(cookies));
  }
  async clear(): Promise<void> { await fs.rm(this.filePath, { force: true }); }
}

export class JournalStore {
  private entries: SyncJournal[] = [];
  private loaded = false;
  private queue = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid journal');
      this.entries = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('同步日志无法读取，请保留该文件并恢复备份；自动同步已停止。');
    }
    this.loaded = true;
  }
  find(accountId: string, filePath: string, inventoryId: string): SyncJournal | undefined {
    if (!this.loaded) throw new Error('同步日志尚未成功载入，不能建立新连接。');
    const found = this.entries.find(j => j.accountId === accountId && samePath(j.filePath, filePath) && (j.inventoryId === inventoryId || j.replacement?.inventoryId === inventoryId));
    return found ? structuredClone(found) : undefined;
  }
  save(journal: SyncJournal, oldPath?: string): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error('同步日志尚未成功载入，已阻止覆盖原日志。'));
    const snapshot = structuredClone(journal);
    const task = this.queue.then(async () => {
      const next = this.entries.filter(j => !(j.accountId === snapshot.accountId && (j.inventoryId === snapshot.inventoryId || j.replacement?.inventoryId === snapshot.inventoryId) && (samePath(j.filePath, snapshot.filePath) || (oldPath && samePath(j.filePath, oldPath)))));
      next.push(snapshot);
      await atomicWrite(this.filePath, JSON.stringify(next));
      this.entries = next;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
