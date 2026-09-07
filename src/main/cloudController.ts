import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CloudStatus, InventoryDocument, InventoryFile, StockRecord } from '../shared/types';
import { CloudClient, ADMIN_ORIGIN } from './cloudClient';
import { CloudError, inventoryHash, samePath, SyncAdapter, SyncEngine, SyncJournal } from './cloudSync';
import { JournalStore } from './cloudStore';

export interface CloudHost {
  current(): InventoryDocument;
  read(filePath: string): Promise<InventoryFile | null>;
  change: SyncAdapter['change'];
  download(record: StockRecord): Promise<InventoryDocument>;
  emit(status: CloudStatus): void;
}

export class CloudController {
  private engine: SyncEngine | null = null;
  private status: CloudStatus = { state: 'local-only', message: '本地库存可离线使用。登录后选择连接才会上传。', account: null, secureStorage: false, connected: false, pending: false, lastSuccess: null };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controls = Promise.resolve();
  constructor(readonly client: CloudClient, private readonly journals: JournalStore, private readonly host: CloudHost) {}
  snapshot(): CloudStatus {
    return { ...this.status, account: this.client.account, secureStorage: this.client.secureStorage, connected: Boolean(this.engine), pending: Boolean(this.engine?.journal.pending) || this.status.state === 'queued', lastSuccess: this.engine?.journal.lastSuccess ?? null };
  }
  private emit(patch: Partial<CloudStatus> = {}): CloudStatus { this.status = { ...this.status, ...patch }; const current = this.snapshot(); this.host.emit(current); return current; }
  control<T>(task: () => Promise<T>): Promise<T> {
    const next = this.controls.then(task, task);
    this.controls = next.then(() => undefined, () => undefined);
    return next;
  }
  async initialize(): Promise<void> {
    await this.journals.load();
    try { await this.client.restore(); } catch { this.emit({ state: 'offline', message: '无法验证云端登录；本地库存仍可使用。' }); }
    await this.selectCurrent();
  }
  private makeEngine(journal: SyncJournal): SyncEngine {
    return new SyncEngine(journal, {
      server: ADMIN_ORIGIN, read: filePath => this.host.read(filePath), change: this.host.change,
      save: value => this.journals.save(value),
      request: (method, id, body) => {
        const account = this.client.requireAccount();
        if (account.id !== journal.accountId) throw new CloudError('账号已改变，原账号的待发内容已保留。', 401);
        return this.client.stock(method, id, body);
      },
      report: (state, message, _journal, payloadBytes) => this.emit({ state, message, payloadBytes })
    });
  }
  async pause(): Promise<void> { clearTimeout(this.timer); await this.engine?.pause(); }
  async selectCurrent(): Promise<void> {
    await this.pause(); this.engine = null;
    const document = this.host.current(), account = this.client.account;
    if (document.filePath && document.inventory && account && !account.mustChangePassword) {
      const journal = this.journals.find(account.id, document.filePath, document.inventory.inventoryId);
      if (journal) this.engine = this.makeEngine(journal);
    }
    this.emit({ state: this.engine?.journal.conflict ? 'conflict' : this.engine ? 'queued' : 'local-only', message: this.engine ? '已恢复此账号与库存文件的同步连接。' : '此文件仅保存在本地；选择连接后才会上传。' });
    if (this.engine) this.schedule(200);
  }
  schedule(delay = 800): void {
    clearTimeout(this.timer);
    if (!this.engine) return;
    if (!['uploading', 'downloading', 'conflict'].includes(this.status.state)) this.emit({ state: 'queued', message: '本地已保存，等待同步。' });
    this.timer = setTimeout(() => { void this.retry().finally(() => {
      if (this.engine && this.status.state !== 'expired' && this.status.state !== 'conflict') this.timer = setTimeout(() => this.schedule(0), 30000);
    }); }, delay);
    this.timer.unref();
  }
  async retry(): Promise<CloudStatus> {
    this.engine?.resume();
    await this.engine?.run();
    return this.snapshot();
  }
  async login(username: string, password: string): Promise<CloudStatus> {
    await this.pause(); this.engine = null;
    try { await this.client.login(username, password); await this.selectCurrent(); return this.emit(); }
    catch (error) { this.emit({ state: 'expired', message: error instanceof Error ? error.message : '登录失败。' }); throw error; }
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<CloudStatus> {
    await this.pause();
    try { await this.client.changePassword(currentPassword, newPassword); await this.selectCurrent(); return this.emit(); }
    catch (error) { this.emit({ state: 'error', message: '密码修改失败，请检查密码策略后重试。' }); throw error; }
  }
  async logout(): Promise<CloudStatus> {
    await this.pause(); this.engine = null;
    try { await this.client.logout(); return this.emit({ state: 'local-only', message: '已退出云端，库存保留在本地。' }); }
    catch { return this.emit({ state: 'local-only', message: '本机登录凭据已清除。网络失败，服务器会话撤销未确认；待发内容保留在原账号下。' }); }
  }
  async connect(): Promise<CloudStatus> {
    await this.pause();
    const account = this.client.requireAccount(), document = this.host.current();
    if (!document.inventory || !document.filePath) throw new CloudError('请先打开库存文件。', 400);
    const existing = this.journals.find(account.id, document.filePath, document.inventory.inventoryId);
    const journal: SyncJournal = existing ?? { accountId: account.id, filePath: document.filePath, inventoryId: document.inventory.inventoryId, version: 0, baseHash: '', pending: null, conflict: false, lastSuccess: null };
    await this.journals.save(journal);
    this.engine = this.makeEngine(journal);
    this.emit({ state: 'queued', message: '已授权连接此库存，正在同步。' });
    this.schedule(0);
    return this.snapshot();
  }
  async download(id: string): Promise<InventoryDocument> {
    await this.pause(); const account = this.client.requireAccount();
    try {
      this.emit({ state: 'downloading', message: '正在获取所选云端库存…' });
      const record = await this.client.stock('GET', id);
      const document = await this.host.download(record);
      if (document.inventory?.inventoryId !== id || !document.filePath) { await this.selectCurrent(); return document; }
      const journal: SyncJournal = { accountId: account.id, filePath: document.filePath, inventoryId: id, version: record.version, baseHash: inventoryHash(record.inventory), pending: null, conflict: false, lastSuccess: new Date().toISOString() };
      await this.journals.save(journal);
      this.engine = this.makeEngine(journal);
      this.emit({ state: 'synced', message: '云端库存已保存为本地文件并连接。' });
      this.schedule(30000);
      return document;
    } catch (error) { this.emit({ state: 'error', message: error instanceof Error ? error.message : '下载失败。' }); throw error; }
  }
  async renamed(oldPath: string): Promise<void> {
    if (this.engine && samePath(this.engine.journal.filePath, oldPath)) {
      const document = this.host.current();
      if (!document.filePath || document.inventory?.inventoryId !== this.engine.journal.inventoryId) throw new Error('库存重命名绑定不一致。');
      this.engine.journal.filePath = path.resolve(document.filePath);
      await this.journals.save(this.engine.journal, oldPath);
    }
    await this.selectCurrent();
  }
  async resolve(choice: 'use-cloud' | 'upload-new'): Promise<InventoryDocument> {
    if (!this.engine || !this.engine.journal.conflict) throw new CloudError('此库存没有待处理的同步冲突。', 400);
    await this.pause();
    if (choice === 'use-cloud') {
      try { await this.engine.useCloud(); this.schedule(30000); }
      catch (error) { this.emit({ state: 'conflict', message: '未替换本地内容，请检查错误后重新选择。' }); throw error; }
    }
    else if (choice === 'upload-new') {
      const old = this.engine.journal;
      await this.host.change(old.filePath, old.inventoryId, current => {
        const { cloudLink: _oldLink, ...local } = current;
        return { ...local, inventoryId: randomUUID(), inventoryName: `${local.inventoryName}（本地副本）`.slice(0,200), updatedAt: new Date().toISOString() };
      }, true);
      this.engine = null;
      await this.connect();
    } else throw new CloudError('无效的冲突处理方式。', 400);
    return this.host.current();
  }
}
