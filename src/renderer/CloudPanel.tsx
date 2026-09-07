import { FormEvent, useEffect, useState } from 'react';
import { CloudStatus, InventoryDocument, StockSummary } from '../shared/types';
import './cloud.css';

const names: Record<CloudStatus['state'], string> = { 'local-only': '仅本地', queued: '待同步', uploading: '上传中', downloading: '检查 / 下载中', synced: '已同步', offline: '离线', error: '同步失败', expired: '登录已失效', conflict: '版本冲突' };

export function CloudPanel({ document, onDocument }: { document: InventoryDocument; onDocument: (value: InventoryDocument) => void }): JSX.Element {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState('');
  const [books, setBooks] = useState<StockSummary[]>([]), [bookId, setBookId] = useState('');
  useEffect(() => {
    void window.amaneStock.cloudStatus().then(setStatus).catch(e => setError(String(e)));
    return window.amaneStock.onCloudStatus(setStatus);
  }, []);
  useEffect(() => { setBooks([]); setBookId(''); }, [status?.account?.id]);
  async function action(work: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError('');
    try { await work(); setStatus(await window.amaneStock.cloudStatus()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function login(event: FormEvent): void {
    event.preventDefault();
    void action(async () => { try { setStatus(await window.amaneStock.cloudLogin(username, password)); } finally { setPassword(''); } });
  }
  function changePassword(event: FormEvent): void {
    event.preventDefault();
    void action(async () => { try { setStatus(await window.amaneStock.cloudChangePassword(password, newPassword)); } finally { setPassword(''); setNewPassword(''); } });
  }
  return <section className="cloud-panel" aria-label="云端同步">
    <div className="cloud-summary">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>☁ {status ? names[status.state] : '云端同步'}{status?.account ? ` · ${status.account.displayName || status.account.username}` : ''}</button>
      <span role="status">{status?.message}</span>
      {status?.lastSuccess && <small>上次成功 {new Date(status.lastSuccess).toLocaleString('zh-CN')}</small>}
      {status?.connected && <button type="button" disabled={busy || status.state === 'uploading'} onClick={() => void action(() => window.amaneStock.cloudRetry())}>立即同步 / 重试</button>}
    </div>
    {(status?.state === 'uploading' || status?.state === 'downloading') && <div className="cloud-progress"><progress aria-label="同步进行中" />{status.payloadBytes ? <small>发送快照 {(status.payloadBytes / 1024).toFixed(1)} KiB，等待服务器确认</small> : null}</div>}
    {status?.state === 'conflict' && <div className="cloud-conflict" role="alert">
      <p>本地和云端发生不同修改。选择云端会先在当前文件旁保存可恢复备份；另存为新库存会保留原云端版本。</p>
      <button type="button" disabled={busy} onClick={() => void action(async () => onDocument(await window.amaneStock.cloudResolve('use-cloud')))}>备份本地并使用云端</button>
      <button type="button" disabled={busy} onClick={() => void action(async () => onDocument(await window.amaneStock.cloudResolve('upload-new')))}>备份并上传为新库存</button>
    </div>}
    {open && <div className="cloud-controls">
      {!status?.account ? <form onSubmit={login}>
        <strong>使用现有管理员账号登录</strong>
        <label>用户名<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required maxLength={200} /></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <button disabled={busy}>登录</button>
        <small>登录不会上传文件。选择“连接并上传当前库存”才会启用该文件的自动同步。</small>
      </form> : <>
        {status.account.mustChangePassword && <form onSubmit={changePassword}>
          <strong>首次登录需要更新密码</strong>
          <label>当前密码<input type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} required /></label>
          <label>新密码<input type="password" value={newPassword} autoComplete="new-password" onChange={e => setNewPassword(e.target.value)} required minLength={12} /></label>
          <button disabled={busy}>更新密码</button>
        </form>}
        {!status.account.mustChangePassword && <div className="cloud-book-actions">
          <p>连接将上传此库存的完整内部资料，包括进价与流水；商店仅展示明确上架的商品。</p>
          <button type="button" disabled={busy || !document.inventory || status.connected} onClick={() => void action(() => window.amaneStock.cloudConnect())}>连接并上传当前库存</button>
          <button type="button" disabled={busy} onClick={() => void action(async () => setBooks(await window.amaneStock.cloudBooks()))}>读取云端库存列表</button>
          <label>云端库存<select value={bookId} onChange={e => setBookId(e.target.value)}><option value="">请选择库存</option>{books.map(book => <option key={book.id} value={book.id}>{book.name} · {book.itemCount} 种 · v{book.version}</option>)}</select></label>
          <button type="button" disabled={busy || !bookId} onClick={() => void action(async () => { const next = await window.amaneStock.cloudDownload(bookId); if (next.inventory) onDocument(next); })}>下载并连接所选库存</button>
        </div>}
        <button type="button" disabled={busy} onClick={() => void action(() => window.amaneStock.cloudLogout())}>退出云端账号</button>
      </>}
      {!status?.secureStorage && <small>系统加密存储不可用：登录仅保留到本次应用退出。</small>}
    </div>}
    {error && <p className="cloud-error" role="alert">{error}</p>}
  </section>;
}
