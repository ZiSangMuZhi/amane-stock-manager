import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { InventoryFile, ShopOperation, StockRecord } from '../shared/types';
import { validateStockSnapshot } from './stockPreflight';
import { checkpointShopPrices, flushShopPrices, prepareShopPrices, readShopPriceResolution, sameShopPrice,
  ShopPriceSyncError, type ShopPriceIntent, type ShopPriceCandidate, type ShopPriceTransport } from './shopPriceSync';

export class CloudError extends Error {
  constructor(message: string, readonly status = 0, readonly definitiveRejection = false, readonly inventoryMissing = false) { super(message); }
}

export function checkedShopOperation(value: unknown): ShopOperation {
  const barcode = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 128 &&
    input === input.trim() && !/[\u0000-\u001f\u007f]/.test(input) && !['__proto__', 'constructor', 'prototype'].includes(input);
  const invalid = (): never => { throw new CloudError('商店操作内容无效，请重新选择商品。', 400, true); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const op = value as Record<string, unknown>;
  if (op.type === 'shop-listing-batch' && Object.keys(op).every(key => ['type', 'barcodes', 'listed'].includes(key)) &&
      Array.isArray(op.barcodes) && op.barcodes.length > 0 && op.barcodes.length <= 200 && op.barcodes.every(barcode) &&
      new Set(op.barcodes).size === op.barcodes.length && typeof op.listed === 'boolean') return structuredClone(op) as ShopOperation;
  if (op.type === 'shop-image' && Object.keys(op).every(key => ['type', 'barcode', 'imageId'].includes(key)) && barcode(op.barcode) &&
      (op.imageId === null || typeof op.imageId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(op.imageId))) return structuredClone(op) as ShopOperation;
  return invalid();
}

export interface ShopOperationField { barcode: string; createdAt: string; value: boolean | string | null }
export function captureShopOperation(inventory: InventoryFile, operation: ShopOperation): ShopOperationField[] {
  return (operation.type === 'shop-listing-batch' ? operation.barcodes : [operation.barcode]).map(barcode => {
    const item = inventory.items[barcode];
    if (!item) throw new CloudError('所选商品已改变，请核对后再次保存。', 400);
    return { barcode, createdAt: item.createdAt, value: operation.type === 'shop-image' ? item.shop.imageId : item.listed };
  });
}
export function sameShopOperationFields(a: ShopOperationField[], b: ShopOperationField[]): boolean {
  return a.length === b.length && a.every((field, i) => field.barcode === b[i]?.barcode && field.createdAt === b[i]?.createdAt && field.value === b[i]?.value);
}

export interface PendingShopOperation {
  body: string;
  requestKey: string;
  version: number;
  baseHash: string;
  createdAt: string;
  fields: ShopOperationField[];
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
  shopPrices?: ShopPriceIntent[];
  shopPriceCandidates?: ShopPriceCandidate[];
  /** Explicit conflict resolution may replace this ID only; disappearance must never create another book. */
  overwrite?: true;
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
  registeredBarcodes?: string[];
  shopPricePending?: ShopPriceIntent[];
  shopPriceConflict?: boolean;
  shopOperationPending?: PendingShopOperation;
  shopOperationsSupported?: boolean;
  /** Write-ahead binding change: either ID may be on disk until the replacement is committed. */
  replacement?: { inventoryId: string };
}

export interface SyncAdapter {
  read(filePath: string): Promise<InventoryFile | null>;
  change(filePath: string, inventoryId: string, update: (current: InventoryFile) => InventoryFile, backup?: boolean): Promise<void>;
  save(journal: SyncJournal): Promise<void>;
  backupRemote?(filePath: string, record: StockRecord): Promise<void>;
  shopOperation?(inventoryId: string, body: string): Promise<StockRecord>;
  request(method: 'GET' | 'POST' | 'PUT', inventoryId: string, body?: string): Promise<StockRecord>;
  report(state: 'queued' | 'uploading' | 'downloading' | 'synced' | 'offline' | 'error' | 'expired' | 'conflict', message: string, journal: SyncJournal, bytes?: number): void;
  server: string;
  shopPrices?: ShopPriceTransport;
}

export function samePath(a: string, b: string): boolean { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

/** One account/file job; missing book IDs change only through a durable replacement. Account changes wait for pause(). */
export class SyncEngine {
  private flight: Promise<void> | null = null;
  private paused = false;
  private operationFailure: CloudError | null = null;
  constructor(readonly journal: SyncJournal, private readonly adapter: SyncAdapter) {}

  async pause(): Promise<void> { this.paused = true; await this.flight; }
  resume(): void { this.paused = false; }
  run(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.paused) return Promise.resolve();
    this.flight = this.work().catch(error => {
      if (error instanceof ShopPriceSyncError) {
        const next = { ...this.journal, shopPriceConflict: error.conflict || Boolean(this.journal.shopPriceConflict) };
        return checkpointShopPrices(this.journal, next, value => this.adapter.save(value))
          .then(() => this.report(error.status === 401 ? 'expired' : 'error', error.message))
          .catch(() => {
            // A failing journal must not become an unhandled background rejection or clear the old request.
            if (error.conflict) this.journal.shopPriceConflict = true;
            this.report('error', `${error.message} 同步状态保存失败，请检查本地磁盘后重试。`);
          });
      }
      if (error instanceof CloudError && error.status === 409) {
        this.journal.conflict = true;
        return this.adapter.save(this.journal).then(() => this.report('conflict', '两端版本不同。请先选择保留方式。'))
          .catch(() => this.report('error', '两端版本不同，冲突状态保存失败，请检查本地磁盘。'));
      }
      if (error instanceof CloudError && error.definitiveRejection && [400, 413].includes(error.status)) {
        if (this.journal.pending?.overwrite) {
          // A rejected explicit overwrite needs a new choice and backup, never an ordinary replacement request.
          return checkpointShopPrices(this.journal, { ...this.journal, conflict: true }, value => this.adapter.save(value))
            .then(() => this.report('conflict', `${error.message} 覆盖未完成，请修正本地资料后重新选择处理方式。`))
            .catch(() => {
              this.journal.conflict = true;
              this.report('error', '覆盖请求被拒绝且冲突状态保存失败，原请求已保留，请检查本地磁盘。');
            });
        }
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

  private async acknowledge(record: StockRecord, expectedHash: string, backup = false, shopPrices: ShopPriceIntent[] = [], candidates: ShopPriceCandidate[] = []): Promise<void> {
    this.validateRecord(record);
    const baseHash = inventoryHash(record.inventory);
    const link = { server: this.adapter.server, accountId: this.journal.accountId, version: record.version, baseHash };
    await this.adapter.change(this.journal.filePath, this.journal.inventoryId, current => {
      // Any edits during a request survive, and are compared with the new acknowledged base on the next pass.
      const safeToReplace = inventoryHash(current) === expectedHash;
      if (backup && !safeToReplace) throw new CloudError('准备替换时本地已变化，保留两端版本并等待重新选择。', 409);
      return { ...(safeToReplace ? canonicalSnapshot(record.inventory) : current), cloudLink: link };
    }, backup);
    const registered = new Set(record.shopRegisteredBarcodes ?? []);
    const prepared = [...shopPrices, ...candidates.filter(candidate => registered.has(candidate.barcode)).map(candidate => ({ ...candidate, productId: '' }))];
    // Stock acknowledgement and handoff to the product queue are one durable commit.
    await checkpointShopPrices(this.journal, { ...this.journal, version: record.version, baseHash,
      pending: null, conflict: false, registeredBarcodes: record.shopRegisteredBarcodes, shopOperationsSupported: record.shopOperationsSupported === true,
      shopPricePending: [...(this.journal.shopPricePending ?? []), ...prepared],
      lastSuccess: prepared.length ? this.journal.lastSuccess : new Date().toISOString()
    }, value => this.adapter.save(value));
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
    const next: SyncJournal = { ...this.journal, inventoryId: nextId, version: 0, baseHash: '', pending: null,
      conflict: false, lastSuccess: null, shopPricePending: [], shopPriceConflict: false, registeredBarcodes: undefined, shopOperationsSupported: false };
    delete next.replacement;
    // JournalStore also removes the old binding identified by its durable replacement intent.
    await this.adapter.save(next);
    Object.assign(this.journal, next);
    delete this.journal.replacement;
  }

  private async work(): Promise<void> {
    // Metadata requests have their own idempotency record. They never enter stock recreation or conflict rebasing.
    if (this.journal.shopOperationPending && !await this.flushShopOperation()) return;
    if (this.paused) return;
    const overwrite = this.journal.pending?.overwrite === true;
    let recreated = Boolean(this.journal.replacement);
    if (this.journal.replacement) await this.replaceMissingInventory();
    if (this.journal.conflict) { this.report('conflict', '同步冲突待处理，两端副本已保留。'); return; }
    const request = async (method: 'GET' | 'POST' | 'PUT', body?: string): Promise<StockRecord | null> => {
      try { return await this.adapter.request(method, this.journal.inventoryId, body); }
      catch (error) {
        let missing = error instanceof CloudError && error.inventoryMissing;
        if (missing && overwrite) {
          throw new CloudError('云端库存已删除或绑定已改变，不能继续覆盖；未创建新库存，请重新选择处理方式。', 409);
        }
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
    const flushPrices = async (): Promise<void> => {
      if (!this.journal.shopPricePending?.length || this.paused) return;
      await this.local();
      // A deleted book must be recreated without carrying the old product identities into it.
      const record = await request('GET');
      if (!record) return;
      this.validateRecord(record);
      if (this.journal.shopPriceConflict) throw new ShopPriceSyncError('库存已同步，商店价格冲突待处理。请选择保留商店价格或重新应用本地价格。', 409, true);
      if (!this.adapter.shopPrices) throw new ShopPriceSyncError('库存已同步，商店价格同步尚不可用，待发价格已保留。');
      this.report('uploading', '库存已同步，正在同步已注册商品的价格…');
      await flushShopPrices(this.journal, this.adapter.shopPrices, value => this.adapter.save(value), () => this.paused);
    };
    await flushPrices();
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
          this.journal.registeredBarcodes = record.shopRegisteredBarcodes;
          this.journal.shopOperationsSupported = record.shopOperationsSupported === true;
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
        let shopPrices: ShopPriceIntent[] = [];
        let shopPriceCandidates: ShopPriceCandidate[] = [];
        if (this.journal.version > 0 && this.adapter.shopPrices) {
          try {
            const prepared = await prepareShopPrices(inventory, this.journal.version, this.adapter.shopPrices);
            shopPrices = prepared.intents; shopPriceCandidates = prepared.candidates;
          }
          catch (error) {
            if (error instanceof CloudError && error.inventoryMissing) {
              const existing = await request('GET');
              if (!existing) continue;
            }
            throw error;
          }
        }
        if (this.paused) return;
        const requestKey = randomUUID();
        this.journal.pending = {
          method: this.journal.version === 0 ? 'POST' : 'PUT', requestKey,
          version: this.journal.version, hash: inventoryHash(inventory),
          body: JSON.stringify({ inventory, requestKey, ...(this.journal.version ? { version: this.journal.version } : {}) }), shopPrices, shopPriceCandidates
        };
      }
      // Every attempt persists exact wire bytes first, including a retry after
      // the previous journal write failed while its pending value remained in memory.
      await this.adapter.save(this.journal);
      const pending = this.journal.pending;
      this.report('uploading', '正在发送已保存的库存快照…', Buffer.byteLength(pending.body));
      const record = await request(pending.method, pending.body);
      if (!record) continue;
      await this.acknowledge(record, pending.hash, false, pending.shopPrices, pending.shopPriceCandidates);
      await flushPrices();
      if (this.paused || this.journal.shopPricePending?.length) return;
      // A disappearance discovered while flushing created a replacement that still needs its POST.
      if (this.journal.version === 0) continue;
      if (inventoryHash(await this.local()) === this.journal.baseHash) {
        await checkpointShopPrices(this.journal, { ...this.journal, lastSuccess: new Date().toISOString() }, value => this.adapter.save(value));
        this.report('synced', '本地与云端已同步。');
        return;
      }
      this.report('queued', '上传期间的新修改已排队。');
    }
  }

  requireNoShopOperation(): void {
    if (this.journal.shopOperationPending) throw new CloudError('商店操作尚未确认，请先重试同步，不能丢弃待发操作。', 409);
  }

  async shopOperation(input: ShopOperation, expectedFields?: ShopOperationField[]): Promise<void> {
    const operation = checkedShopOperation(input);
    this.requireNoShopOperation();
    await this.pause();
    try {
      this.requireNoShopOperation();
      if (!this.adapter.shopOperation) throw new CloudError('此版本尚不支持商店操作。', 400);
      if (!this.journal.shopOperationsSupported) throw new CloudError('服务端尚未支持此操作，请先升级 Mac 服务端；本地内容已保留。', 400);
      if (this.journal.conflict || this.journal.pending || this.journal.replacement || this.journal.shopPricePending?.length ||
          this.journal.shopPriceConflict || this.journal.version < 1) throw new CloudError('请先完成库存和商店价格同步，再保存商店操作。', 409);
      const local = await this.local();
      validateStockSnapshot(canonicalSnapshot(local));
      const baseHash = inventoryHash(local);
      if (baseHash !== this.journal.baseHash) throw new CloudError('本地库存已修改，请先完成同步后再次保存。', 409);
      const fields = captureShopOperation(local, operation);
      if (expectedFields && !sameShopOperationFields(fields, expectedFields)) throw new CloudError('云端商品已更新，请核对后再次保存。', 409);
      const requestKey = randomUUID(), version = this.journal.version;
      const next: SyncJournal = { ...this.journal, shopOperationPending: { requestKey, version, baseHash, fields,
        createdAt: new Date().toISOString(), body: JSON.stringify({ version, requestKey, operation }) } };
      await checkpointShopPrices(this.journal, next, value => this.adapter.save(value));
    } finally { this.resume(); }
    this.operationFailure = null;
    await this.run();
    if (this.operationFailure) throw this.operationFailure;
    if (this.journal.shopOperationPending) throw new CloudError('商店操作尚未确认，原请求已保留，请重试同步。');
  }

  private async flushShopOperation(): Promise<boolean> {
    const pending = this.journal.shopOperationPending!;
    let rejected: CloudError | undefined;
    try {
      await this.local();
      if (!this.adapter.shopOperation) throw new CloudError('此版本尚不支持恢复商店操作，原请求已保留。');
      const payload = JSON.parse(pending.body) as { version: number; requestKey: string; operation: unknown };
      const operation = checkedShopOperation(payload.operation);
      if (payload.version !== pending.version || payload.requestKey !== pending.requestKey || pending.fields.length !==
          (operation.type === 'shop-image' ? 1 : operation.barcodes.length) || pending.fields.some((field, i) =>
            field.barcode !== (operation.type === 'shop-image' ? operation.barcode : operation.barcodes[i]))) throw new Error('Invalid operation journal');
      // Persist exact bytes before every retry, including recovery after a failed acknowledgement.
      await this.adapter.save(this.journal);
      if (this.paused) return false;
      this.report('uploading', '正在保存商店上架或图片设置…', Buffer.byteLength(pending.body));
      let record: StockRecord;
      try { record = await this.adapter.shopOperation(this.journal.inventoryId, pending.body); }
      catch (error) {
        if (error instanceof CloudError && ([403, 404, 405, 409, 410, 422, 428].includes(error.status) ||
            error.definitiveRejection && [400, 413].includes(error.status))) rejected = error;
        throw error;
      }
      this.validateRecord(record);
      validateStockSnapshot(canonicalSnapshot(record.inventory));
      if (record.version <= pending.version) throw new CloudError('商店操作响应版本无效，原请求已保留。', 502);
      const desired = operation.type === 'shop-image' ? operation.imageId : operation.listed;
      if (pending.fields.some(field => {
        const item = record.inventory.items[field.barcode];
        return !item || item.createdAt !== field.createdAt || (operation.type === 'shop-image' ? item.shop.imageId : item.listed) !== desired;
      })) throw new CloudError('商店操作响应内容无效，原请求已保留。', 502);
      const baseHash = inventoryHash(record.inventory);
      const link = { server: this.adapter.server, accountId: this.journal.accountId, version: record.version, baseHash };
      await this.adapter.change(this.journal.filePath, this.journal.inventoryId, current => {
        if (inventoryHash(current) === pending.baseHash) return { ...canonicalSnapshot(record.inventory), cloudLink: link };
        const inventory = structuredClone(current);
        for (const field of pending.fields) {
          const item = inventory.items[field.barcode];
          if (!item || item.createdAt !== field.createdAt) continue;
          // Only this operation's field may merge into concurrent edits; a replay never restores an old field.
          if (operation.type === 'shop-image') {
            if (item.shop.imageId === field.value) item.shop.imageId = operation.imageId;
          } else if (item.listed === field.value) item.listed = operation.listed;
        }
        return { ...inventory, cloudLink: link };
      });
      const next = { ...this.journal, version: record.version, baseHash, registeredBarcodes: record.shopRegisteredBarcodes, shopOperationsSupported: record.shopOperationsSupported === true,
        lastSuccess: new Date().toISOString() };
      delete next.shopOperationPending;
      await checkpointShopPrices(this.journal, next, value => this.adapter.save(value));
      // Object.assign does not delete optional properties omitted by the checkpoint.
      delete this.journal.shopOperationPending;
      this.operationFailure = null;
      return true;
    } catch (error) {
      const status = error instanceof CloudError ? error.status : 0;
      let message = status === 409 ? '云端商品已更新，请先同步并核对后再次保存。'
        : status === 403 ? (error instanceof CloudError && error.message.startsWith('服务器拒绝了写入来源或会话校验')
          ? '服务器拒绝了写入来源或会话校验，请更新应用并重新登录后再保存。' : '此账号没有所需的库存或商店商品管理权限，请联系管理员授权。')
        : status === 401 ? '登录已失效，商店操作原请求已保留，请重新登录后重试同步。'
        : rejected ? `服务器拒绝商店操作（HTTP ${status}），请检查商品和服务版本后再次保存。`
        : '商店操作尚未确认，原请求已保留，请检查网络或本地文件后重试同步。';
      if (rejected) {
        try {
          const next = { ...this.journal };
          delete next.shopOperationPending;
          await checkpointShopPrices(this.journal, next, value => this.adapter.save(value));
          delete this.journal.shopOperationPending;
        } catch { message += ' 待发状态保存失败，原请求仍保留，请检查本地磁盘。'; }
      }
      this.operationFailure = new CloudError(message, status);
      this.report(status === 401 ? 'expired' : status > 0 || rejected ? 'error' : 'offline', message);
      return false;
    }
  }

  async useLocal(): Promise<void> {
    const requireChoice = (): void => {
      this.requireNoShopOperation();
      if (!this.journal.conflict) throw new CloudError('此库存没有待处理的同步冲突。', 400);
      if (this.journal.shopPricePending?.length || this.journal.shopPriceConflict) {
        throw new ShopPriceSyncError('请先处理待同步或冲突的商店价格，再选择覆盖云端库存。', 409, true);
      }
      if (this.journal.replacement) throw new CloudError('库存正在恢复新的云端绑定，不能覆盖原库存。', 409);
    };
    requireChoice();
    await this.pause();
    try {
      requireChoice();
      if (!this.adapter.backupRemote) throw new CloudError('当前环境无法备份云端副本，已停止覆盖。', 400);
      const inventory = canonicalSnapshot(await this.local());
      validateStockSnapshot(inventory);
      const expectedHash = inventoryHash(inventory);
      this.report('downloading', '正在读取最新云端版本并准备覆盖前备份…');
      const record = await this.adapter.request('GET', this.journal.inventoryId);
      this.validateRecord(record);
      try { validateStockSnapshot(canonicalSnapshot(record.inventory)); }
      catch { throw new CloudError('云端库存格式无效，已停止覆盖并保留本地内容。', 502); }
      // Use the latest remote version and the normal managed-price rules, not the stale conflict snapshot.
      const prepared = this.adapter.shopPrices
        ? await prepareShopPrices(inventory, record.version, this.adapter.shopPrices)
        : { intents: [], candidates: [] };
      await this.adapter.backupRemote(this.journal.filePath, structuredClone(record));
      if (inventoryHash(await this.local()) !== expectedHash) {
        throw new CloudError('准备覆盖时本地文件已修改，云端未覆盖，请重新选择处理方式。', 409);
      }
      const requestKey = randomUUID();
      const next: SyncJournal = { ...this.journal, version: record.version, baseHash: inventoryHash(record.inventory),
        registeredBarcodes: record.shopRegisteredBarcodes, shopOperationsSupported: record.shopOperationsSupported === true, conflict: false,
        pending: { method: 'PUT', requestKey, version: record.version, hash: expectedHash, overwrite: true,
          body: JSON.stringify({ inventory, version: record.version, requestKey }),
          shopPrices: prepared.intents, shopPriceCandidates: prepared.candidates }
      };
      // Preserve the old conflicting request until its backed-up replacement is durably committed.
      await checkpointShopPrices(this.journal, next, value => this.adapter.save(value));
    } catch (error) {
      if (error instanceof CloudError && error.inventoryMissing) {
        throw new CloudError('云端库存已删除或不存在，不能覆盖；未创建新库存，请重新选择处理方式。', 409);
      }
      throw error;
    } finally { this.resume(); }
    // Failed preparation exits above with the old conflict intact; it must never dispatch an overwrite.
    await this.run();
  }

  async useCloud(): Promise<void> {
    this.requireNoShopOperation();
    if (this.journal.shopPricePending?.length) throw new ShopPriceSyncError('请先处理待同步的商店价格，再选择库存副本。', 409, true);
    await this.pause();
    this.requireNoShopOperation();
    if (this.journal.shopPricePending?.length) {
      this.resume();
      throw new ShopPriceSyncError('请先处理待同步的商店价格，再选择库存副本。', 409, true);
    }
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

  async resolveShopPrices(choice: 'retry-local' | 'keep-shop'): Promise<void> {
    this.requireNoShopOperation();
    if (!['retry-local', 'keep-shop'].includes(choice)) throw new Error('无效的价格处理方式。');
    await this.pause();
    try {
      this.requireNoShopOperation();
      const pending = this.journal.shopPricePending ?? [];
      if (!pending.length) return;
      if (!this.adapter.shopPrices) throw new ShopPriceSyncError('商店价格同步尚不可用，待发价格已保留。');
      // Lock automatic dispatch before a resolution touches the file. A crash/save failure after
      // keep-shop updates the file must not later replay the older desired price without consent.
      await checkpointShopPrices(this.journal, { ...this.journal, shopPriceConflict: true }, value => this.adapter.save(value));
      const resolved = await readShopPriceResolution(pending, this.adapter.shopPrices);
      if (choice === 'keep-shop') {
        await this.adapter.change(this.journal.filePath, this.journal.inventoryId, current => {
          const inventory = structuredClone(current);
          for (const { intent, price } of resolved) {
            const item = inventory.items[intent.barcode];
            // New edits made after the failed upload or during this GET remain queued.
            if (item && sameShopPrice(item.shop, intent.desired)) {
              item.shop = { ...item.shop, ...price };
              if (item.priceCurrency === 'CAD') item.salePriceAmount = price.currentCents / 100;
              item.updatedAt = inventory.updatedAt = new Date().toISOString();
            }
          }
          return inventory;
        });
      }
      await checkpointShopPrices(this.journal, { ...this.journal, shopPriceConflict: false,
        shopPricePending: choice === 'keep-shop' ? [] : resolved.map(({ intent, price }) => {
          const { request: _oldRequest, ...rest } = intent;
          return { ...rest, base: price };
        })
      }, value => this.adapter.save(value));
    } finally { this.resume(); }
    await this.run();
  }
}
