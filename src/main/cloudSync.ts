import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { InventoryFile, StockRecord } from '../shared/types';
import { validateStockSnapshot } from './stockPreflight';

export class CloudError extends Error {
  constructor(message: string, readonly status = 0, readonly definitiveRejection = false, readonly inventoryMissing = false) { super(message); }
}

export function canonicalSnapshot(inventory: InventoryFile): InventoryFile {
  const { cloudLink: _local, ...document } = inventory;
  return structuredClone(document);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, sorted(v)]));
  return value;
}

export function inventoryHash(inventory: InventoryFile): string {
  return createHash('sha256').update(JSON.stringify(sorted(canonicalSnapshot(inventory)))).digest('hex');
}

export interface PendingSnapshot {
  method: 'POST' | 'PUT';
  requestKey: string;
  version: number;
  hash: string;
  body: string;
}

export interface SyncJournal {
  accountId: string;
  filePath: string;
  inventoryId: string;
  version: number;
  baseHash: string;
  pending: PendingSnapshot | null;
  conflict: boolean;
  lastSuccess: string | null;
  /** Write-ahead binding change: either ID may be on disk until the replacement is committed. */
  replacement?: { inventoryId: string };
}

export interface SyncAdapter {
  read(filePath: string): Promise<InventoryFile | null>;
  change(filePath: string, inventoryId: string, update: (current: InventoryFile) => InventoryFile, backup?: boolean): Promise<void>;
  save(journal: SyncJournal): Promise<void>;
  request(method: 'GET' | 'POST' | 'PUT', inventoryId: string, body?: string): Promise<StockRecord>;
  report(state: 'queued' | 'uploading' | 'downloading' | 'synced' | 'offline' | 'error' | 'expired' | 'conflict', message: string, journal: SyncJournal, bytes?: number): void;
  server: string;
}

export function samePath(a: string, b: string): boolean { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

/** One account/file job; missing book IDs change only through a durable replacement. Account changes wait for pause(). */
export class SyncEngine {
  private flight: Promise<void> | null = null;
  private paused = false;
  constructor(readonly journal: SyncJournal, private readonly adapter: SyncAdapter) {}

  async pause(): Promise<void> { this.paused = true; await this.flight; }
  resume(): void { this.paused = false; }
  run(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.paused) return Promise.resolve();
    this.flight = this.work().catch(error => {
      if (error instanceof CloudError && error.status === 409) {
        this.journal.conflict = true;
        return this.adapter.save(this.journal).then(() => this.report('conflict', '两端版本不同。请先选择保留方式。'));
      }
      if (error instanceof CloudError && error.definitiveRejection && [400, 413].includes(error.status)) {
        // Definitive validation rejection cannot have committed a stock mutation. Corrected local input may use a fresh key.
        this.journal.pending = null;
        return this.adapter.save(this.journal).then(() => this.report('error', `${error.message} 请修正本地资料后重试。`));
      }
      this.report(error instanceof CloudError && error.status === 401 ? 'expired' : error instanceof CloudError && error.status > 0 ? 'error' : 'offline',
        error instanceof Error ? error.message : '同步失败；本地内容与待发请求已保留。');
    }).finally(() => { this.flight = null; });
    return this.flight;
  }

  private report(state: Parameters<SyncAdapter['report']>[0], message: string, bytes?: number): void {
    this.adapter.report(state, message, this.journal, bytes);
  }

  private async local(): Promise<InventoryFile> {
    const local = await this.adapter.read(this.journal.filePath);
    if (!local || local.inventoryId !== this.journal.inventoryId) throw new CloudError('连接的本地文件已改变，已停止同步。', 400);
    return local;
  }

  private validateRecord(record: StockRecord): void {
    if (!record || record.id !== this.journal.inventoryId || record.inventory?.inventoryId !== record.id ||
        record.inventory.schemaVersion !== 7 || !Number.isSafeInteger(record.version) || record.version < 1) {
      throw new CloudError('服务器返回了不匹配的库存，已保留本地文件。', 502);
    }
  }

  private async acknowledge(record: StockRecord, expectedHash: string, backup = false): Promise<void> {
    this.validateRecord(record);
    const baseHash = inventoryHash(record.inventory);
    const link = { server: this.adapter.server, accountId: this.journal.accountId, version: record.version, baseHash };
    await this.adapter.change(this.journal.filePath, this.journal.inventoryId, current => {
      // Any edits during a request survive, and are compared with the new acknowledged base on the next pass.
      const safeToReplace = inventoryHash(current) === expectedHash;
      if (backup && !safeToReplace) throw new CloudError('准备替换时本地已变化，保留两端版本并等待重新选择。', 409);
      return { ...(safeToReplace ? canonicalSnapshot(record.inventory) : current), cloudLink: link };
    }, backup);
    this.journal.version = record.version;
    this.journal.baseHash = baseHash;
    this.journal.pending = null;
    this.journal.conflict = false;
    this.journal.lastSuccess = new Date().toISOString();
    await this.adapter.save(this.journal);
  }

  private async replaceMissingInventory(): Promise<void> {
    if (!this.journal.replacement) {
      // Commit the next ID before touching the local file. A crash must not allocate another copy.
      const intent = { ...this.journal, replacement: { inventoryId: randomUUID() } };
      await this.adapter.save(intent);
      Object.assign(this.journal, intent);
    }
    const nextId = this.journal.replacement!.inventoryId;
    const local = await this.adapter.read(this.journal.filePath);
    if (!local || ![this.journal.inventoryId, nextId].includes(local.inventoryId)) {
      throw new CloudError('连接的本地文件已改变，已停止重新上传。', 400);
    }
    this.report('queued', '云端库存已删除或不存在，正在保留本地备份并重新上传…');
    if (local.inventoryId !== nextId) {
      await this.adapter.change(this.journal.filePath, this.journal.inventoryId, current => {
        const { cloudLink: _oldLink, ...inventory } = current;
        return { ...inventory, inventoryId: nextId };
      }, true);
    }
    const next: SyncJournal = { ...this.journal, inventoryId: nextId, version: 0, baseHash: '', pending: null, conflict: false, lastSuccess: null };
    delete next.replacement;
    // JournalStore also removes the old binding identified by its durable replacement intent.
    await this.adapter.save(next);
    Object.assign(this.journal, next);
    delete this.journal.replacement;
  }

  private async work(): Promise<void> {
    let recreated = Boolean(this.journal.replacement);
    if (this.journal.replacement) await this.replaceMissingInventory();
    if (this.journal.conflict) { this.report('conflict', '同步冲突待处理，两端副本已保留。'); return; }
    const request = async (method: 'GET' | 'POST' | 'PUT', body?: string): Promise<StockRecord | null> => {
      try { return await this.adapter.request(method, this.journal.inventoryId, body); }
      catch (error) {
        let missing = error instanceof CloudError && error.inventoryMissing;
        // A write's old idempotency key can be tombstoned even if somebody has
        // since recreated that ID. Verify current absence before allocating a new ID.
        // A fresh POST into a retained soft-deleted ID instead returns 409.
        if (!recreated && method !== 'GET' && (missing || method === 'POST' && error instanceof CloudError && error.status === 409)) {
          let current: StockRecord | undefined;
          try { current = await this.adapter.request('GET', this.journal.inventoryId); }
          catch (probe) {
            if (!(probe instanceof CloudError && probe.inventoryMissing)) throw probe;
            missing = true;
          }
          if (current) {
            this.validateRecord(current);
            if (missing) throw new CloudError('云端库存已重新建立，请先选择保留方式。', 409);
          }
        }
        if (!missing || recreated || this.paused) throw error;
        recreated = true;
        await this.replaceMissingInventory();
        return null;
      }
    };
    for (let pass = 0; pass < 5 && !this.paused; pass++) {
      const local = await this.local();
      if (!this.journal.pending && this.journal.version > 0 && inventoryHash(local) === this.journal.baseHash) {
        this.report('downloading', '正在检查云端版本…');
        const record = await request('GET');
        if (!record) continue;
        this.validateRecord(record);
        if (record.version < this.journal.version) throw new CloudError('云端版本倒退，已停止同步。', 409);
        if (record.version !== this.journal.version) {
          // If the local copy changed while fetching, do not advance its base: that would hide a real conflict.
          if (inventoryHash(await this.local()) !== this.journal.baseHash) throw new CloudError('读取云端时本地也发生变化。', 409);
          await this.acknowledge(record, this.journal.baseHash, true);
        }
        if (inventoryHash(await this.local()) === this.journal.baseHash) {
          this.journal.lastSuccess = new Date().toISOString();
          await this.adapter.save(this.journal);
          this.report('synced', '本地与云端已同步。');
          return;
        }
      }
      if (this.paused) return;
      if (!this.journal.pending) {
        const latest = await this.local();
        const inventory = canonicalSnapshot(latest);
        validateStockSnapshot(inventory);
        const requestKey = randomUUID();
        this.journal.pending = {
          method: this.journal.version === 0 ? 'POST' : 'PUT', requestKey,
          version: this.journal.version, hash: inventoryHash(inventory),
          body: JSON.stringify({ inventory, requestKey, ...(this.journal.version ? { version: this.journal.version } : {}) })
        };
      }
      // Every attempt persists exact wire bytes first, including a retry after
      // the previous journal write failed while its pending value remained in memory.
      await this.adapter.save(this.journal);
      const pending = this.journal.pending;
      this.report('uploading', '正在发送已保存的库存快照…', Buffer.byteLength(pending.body));
      const record = await request(pending.method, pending.body);
      if (!record) continue;
      await this.acknowledge(record, pending.hash);
      if (inventoryHash(await this.local()) === this.journal.baseHash) {
        this.report('synced', '本地与云端已同步。');
        return;
      }
      this.report('queued', '上传期间的新修改已排队。');
    }
  }

  async useCloud(): Promise<void> {
    await this.pause();
    this.report('downloading', '正在获取云端副本并备份本地文件…');
    const expected = inventoryHash(await this.local());
    const record = await this.adapter.request('GET', this.journal.inventoryId);
    this.validateRecord(record);
    // Explicit replacement still refuses to lose edits made after the user's choice.
    if (inventoryHash(await this.local()) !== expected) throw new CloudError('下载时本地已修改，请再次选择处理方式。', 409);
    await this.acknowledge(record, expected, true);
    this.resume();
    this.report('synced', '已保存本地备份并使用云端副本。');
  }
}
