import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BadgeCheck,
  Barcode,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  FileJson,
  FilePlus2,
  FolderOpen,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  PackagePlus,
  PackageX,
  Pencil,
  RefreshCw,
  Save,
  ScanBarcode,
  SearchX,
  Sheet,
  UploadCloud,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import './styles.css';
import {
  ExportFormat,
  InventoryDocument,
  InventoryItem,
  InventoryMode,
  LookupStatus,
  UpdateStatus
} from '../shared/types';

type Notice = { type: 'info' | 'success' | 'warning' | 'error'; text: string };

const emptyDocument: InventoryDocument = { filePath: null, fileName: '', inventory: null };

function App(): JSX.Element {
  const [document, setDocument] = useState<InventoryDocument>(emptyDocument);
  const [mode, setMode] = useState<InventoryMode>('in');
  const [barcode, setBarcode] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [version, setVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const inventory = document.inventory;
  const items = useMemo(() => sortItems(Object.values(inventory?.items ?? {})), [inventory]);
  const totals = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc.quantity += item.quantityOnHand;
        acc.in += item.totalIn;
        acc.out += item.totalOut;
        return acc;
      },
      { quantity: 0, in: 0, out: 0 }
    );
  }, [items]);

  useEffect(() => {
    window.amaneStock.getCurrentInventory().then(setDocument).catch(showError);
    window.amaneStock.getVersion().then(setVersion).catch(() => setVersion('0.1.2'));
  }, []);

  useEffect(() => {
    const nextDrafts = Object.fromEntries(items.map((item) => [item.barcode, item.nickname]));
    setNicknameDrafts(nextDrafts);
  }, [items]);

  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, [document.filePath, mode, busy]);

  async function runAction<T>(action: () => Promise<T>, onSuccess?: (result: T) => void): Promise<void> {
    setBusy(true);
    try {
      const result = await action();
      onSuccess?.(result);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      barcodeInputRef.current?.focus();
    }
  }

  function showError(error: unknown): void {
    setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
  }

  async function handleCreate(): Promise<void> {
    await runAction(() => window.amaneStock.createInventory(), (next) => {
      setDocument(next);
      if (next.inventory) {
        setNotice({ type: 'success', text: '已新建库存文件。' });
      }
    });
  }

  async function handleOpen(): Promise<void> {
    await runAction(() => window.amaneStock.openInventory(), (next) => {
      setDocument(next);
      if (next.inventory) {
        setNotice({ type: 'success', text: '已打开库存文件。' });
      }
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!inventory) {
      setNotice({ type: 'warning', text: '请先新建或打开库存文件。' });
      return;
    }
    const value = barcode.trim();
    if (!value) {
      return;
    }

    await runAction(() => window.amaneStock.submitBarcode(value, mode), (result) => {
      setDocument(result.document);
      setBarcode('');
      setNotice({ type: result.ok ? 'success' : 'warning', text: result.message });
    });
  }

  async function handleRename(): Promise<void> {
    const name = draftName.trim();
    if (!name) {
      setNotice({ type: 'warning', text: '库存文件名不能为空。' });
      return;
    }

    await runAction(() => window.amaneStock.renameInventory(name), (next) => {
      setDocument(next);
      setRenameOpen(false);
      setNotice({ type: 'success', text: '已重命名库存文件。' });
    });
  }

  async function handleNicknameBlur(item: InventoryItem): Promise<void> {
    const draft = nicknameDrafts[item.barcode] ?? '';
    if (draft.trim() === item.nickname) {
      return;
    }

    await runAction(() => window.amaneStock.updateNickname(item.barcode, draft), (next) => {
      setDocument(next);
      setNotice({ type: 'success', text: '昵称已保存。' });
    });
  }

  async function handleRefreshLookup(item: InventoryItem): Promise<void> {
    await runAction(() => window.amaneStock.refreshLookup(item.barcode), (result) => {
      setDocument(result.document);
      setNotice({ type: result.ok ? 'success' : 'warning', text: result.message });
    });
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    setExportOpen(false);
    await runAction(() => window.amaneStock.exportInventory(format), (result) => {
      setNotice({ type: result.ok ? 'success' : 'info', text: result.message });
    });
  }

  async function handleCheckUpdates(): Promise<void> {
    await runAction(() => window.amaneStock.checkForUpdates(), (status) => {
      setUpdateStatus(status);
      setNotice({ type: status.state === 'available' ? 'success' : status.state === 'error' ? 'error' : 'info', text: status.message });
    });
  }

  async function handleDownloadUpdate(): Promise<void> {
    await runAction(() => window.amaneStock.downloadUpdate(), (status) => {
      setUpdateStatus(status);
      setNotice({ type: status.state === 'downloaded' ? 'success' : 'info', text: status.message });
    });
  }

  async function handleApplyUpdate(): Promise<void> {
    await runAction(() => window.amaneStock.applyUpdate(), (status) => {
      setUpdateStatus(status);
      setNotice({ type: 'info', text: status.message });
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Boxes size={22} />
          </div>
          <div className="brand-copy">
            <strong>Amane Stock Manager</strong>
            <span>{version ? `v${version}` : 'v0.1.2'}</span>
          </div>
        </div>

        <div className="file-strip" title={document.filePath ?? ''}>
          <FileJson size={18} />
          <span>{document.fileName || '未打开库存文件'}</span>
        </div>

        <div className="toolbar">
          <button type="button" className="tool-button" onClick={handleCreate} disabled={busy}>
            <FilePlus2 size={18} />
            <span>新建</span>
          </button>
          <button type="button" className="tool-button" onClick={handleOpen} disabled={busy}>
            <FolderOpen size={18} />
            <span>打开</span>
          </button>
          <button
            type="button"
            className="tool-button"
            onClick={() => {
              setDraftName(inventory?.inventoryName ?? '');
              setRenameOpen(true);
            }}
            disabled={busy || !inventory}
          >
            <Pencil size={18} />
            <span>重命名</span>
          </button>
          <div className="popover-anchor">
            <button
              type="button"
              className="tool-button"
              onClick={() => setExportOpen((open) => !open)}
              disabled={busy || !inventory}
            >
              <Download size={18} />
              <span>导出</span>
            </button>
            {exportOpen && (
              <div className="popover export-popover">
                <button type="button" onClick={() => handleExport('csv-items')}>
                  <Sheet size={17} />
                  <span>CSV 汇总</span>
                </button>
                <button type="button" onClick={() => handleExport('csv-transactions')}>
                  <Sheet size={17} />
                  <span>CSV 流水</span>
                </button>
                <button type="button" onClick={() => handleExport('xlsx')}>
                  <Sheet size={17} />
                  <span>XLSX</span>
                </button>
                <button type="button" onClick={() => handleExport('json')}>
                  <FileJson size={17} />
                  <span>JSON</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="workspace">
        <section className="control-band">
          <div className="mode-control" aria-label="库存模式">
            <button type="button" className={mode === 'in' ? 'active in' : ''} onClick={() => setMode('in')}>
              <PackagePlus size={18} />
              <span>录入模式</span>
            </button>
            <button type="button" className={mode === 'out' ? 'active out' : ''} onClick={() => setMode('out')}>
              <PackageMinus size={18} />
              <span>出库模式</span>
            </button>
          </div>

          <form className={`scan-form ${mode}`} onSubmit={handleSubmit}>
            <label htmlFor="barcode-input">
              <ScanBarcode size={20} />
              <span>条码</span>
            </label>
            <input
              ref={barcodeInputRef}
              id="barcode-input"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              disabled={busy || !inventory}
              placeholder={inventory ? 'Barcode' : '先新建或打开库存文件'}
              autoComplete="off"
            />
            <button type="submit" disabled={busy || !inventory || !barcode.trim()}>
              {mode === 'in' ? <PackagePlus size={19} /> : <PackageMinus size={19} />}
              <span>{mode === 'in' ? '录入' : '出库'}</span>
            </button>
          </form>

          <div className="summary-row">
            <Metric label="当前库存" value={totals.quantity} icon={<PackageCheck size={18} />} />
            <Metric label="累计录入" value={totals.in} icon={<PackagePlus size={18} />} />
            <Metric label="累计出库" value={totals.out} icon={<PackageMinus size={18} />} />
          </div>
        </section>

        <section className="status-band">
          {notice ? (
            <div className={`notice ${notice.type}`}>
              {noticeIcon(notice.type)}
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
          ) : (
            <div className="notice neutral">
              <Barcode size={17} />
              <span>{inventory ? '就绪' : '未打开库存文件'}</span>
            </div>
          )}

          <div className="update-strip">
            <span className={`update-dot ${updateStatus?.state ?? 'idle'}`} />
            <span>{updateStatus?.message ?? '更新状态未检查'}</span>
            <button type="button" onClick={handleCheckUpdates} disabled={busy}>
              <RefreshCw size={16} />
              <span>检查更新</span>
            </button>
            {updateStatus?.state === 'available' && (
              <button type="button" onClick={handleDownloadUpdate} disabled={busy}>
                <Download size={16} />
                <span>下载</span>
              </button>
            )}
            {updateStatus?.state === 'downloaded' && (
              <button type="button" onClick={handleApplyUpdate} disabled={busy}>
                <UploadCloud size={16} />
                <span>安装</span>
              </button>
            )}
          </div>
        </section>

        {!inventory && (
          <section className="empty-state">
            <PackageOpen size={48} />
            <div>
              <h1>库存文件</h1>
              <div className="empty-actions">
                <button type="button" onClick={handleCreate}>
                  <FilePlus2 size={18} />
                  <span>新建</span>
                </button>
                <button type="button" onClick={handleOpen}>
                  <FolderOpen size={18} />
                  <span>打开</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {inventory && (
          <section className="inventory-grid" aria-label="库存商品">
            {items.length === 0 ? (
              <div className="empty-grid">
                <ScanBarcode size={36} />
                <span>暂无商品</span>
              </div>
            ) : (
              items.map((item) => (
                <article className={`item-card ${item.quantityOnHand === 0 ? 'empty' : ''}`} key={item.barcode}>
                  <div className="item-head">
                    <div className={`stock-icon ${item.quantityOnHand === 0 ? 'zero' : 'ok'}`} aria-hidden="true">
                      {item.quantityOnHand === 0 ? <PackageX size={24} /> : <PackageCheck size={24} />}
                    </div>
                    <div className="item-title">
                      <h2>{item.nickname || item.lookupName || item.barcode}</h2>
                      <span>{item.lookupName || '未识别商品'}</span>
                    </div>
                    <strong className="quantity">{item.quantityOnHand}</strong>
                  </div>

                  <div className="barcode-line">
                    <Barcode size={16} />
                    <code>{item.barcode}</code>
                  </div>

                  <label className="nickname-field">
                    <span>昵称</span>
                    <input
                      value={nicknameDrafts[item.barcode] ?? ''}
                      onChange={(event) =>
                        setNicknameDrafts((drafts) => ({ ...drafts, [item.barcode]: event.target.value }))
                      }
                      onBlur={() => handleNicknameBlur(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>

                  <div className="status-row">
                    <StatusPill status={item.lookupStatus} />
                    <span className="source-pill">
                      <Wifi size={15} />
                      {sourceLabel(item.lookupSource, item.lookupConfidence)}
                    </span>
                    <span className={`stock-pill ${item.quantityOnHand === 0 ? 'zero' : 'ok'}`}>
                      {item.quantityOnHand === 0 ? <PackageX size={15} /> : <BadgeCheck size={15} />}
                      {item.quantityOnHand === 0 ? '库存为 0' : '库存正常'}
                    </span>
                    <button type="button" className="icon-button" onClick={() => handleRefreshLookup(item)} disabled={busy}>
                      <RefreshCw size={15} />
                    </button>
                  </div>

                  <dl className="item-stats">
                    <div>
                      <dt>录入</dt>
                      <dd>{item.totalIn}</dd>
                    </div>
                    <div>
                      <dt>出库</dt>
                      <dd>{item.totalOut}</dd>
                    </div>
                    <div>
                      <dt>品牌</dt>
                      <dd>{item.brand || '-'}</dd>
                    </div>
                    <div>
                      <dt>分类</dt>
                      <dd>{item.category || '-'}</dd>
                    </div>
                  </dl>

                  <dl className="time-list">
                    <div>
                      <dt>最近录入</dt>
                      <dd>{formatTime(item.lastInAt)}</dd>
                    </div>
                    <div>
                      <dt>最近出库</dt>
                      <dd>{formatTime(item.lastOutAt)}</dd>
                    </div>
                  </dl>
                </article>
              ))
            )}
          </section>
        )}
      </main>

      {renameOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <div className="modal-head">
              <h2 id="rename-title">重命名库存文件</h2>
              <button type="button" onClick={() => setRenameOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleRename();
                }
              }}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setRenameOpen(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={handleRename}>
                <Save size={17} />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }): JSX.Element {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: LookupStatus }): JSX.Element {
  const map: Record<LookupStatus, { className: string; label: string; icon: JSX.Element }> = {
    idle: { className: 'idle', label: '未查询', icon: <SearchX size={15} /> },
    loading: { className: 'loading', label: '查询中', icon: <RefreshCw size={15} /> },
    found: { className: 'found', label: '已识别', icon: <Wifi size={15} /> },
    not_found: { className: 'not-found', label: '未识别', icon: <SearchX size={15} /> },
    error: { className: 'error', label: '查询失败', icon: <WifiOff size={15} /> }
  };
  const value = map[status];
  return (
    <span className={`lookup-pill ${value.className}`}>
      {value.icon}
      {value.label}
    </span>
  );
}

function noticeIcon(type: Notice['type']): JSX.Element {
  if (type === 'success') {
    return <CheckCircle2 size={17} />;
  }
  if (type === 'error') {
    return <CircleAlert size={17} />;
  }
  if (type === 'warning') {
    return <CircleAlert size={17} />;
  }
  return <Barcode size={17} />;
}

function sortItems(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort((a, b) => {
    if (b.quantityOnHand !== a.quantityOnHand) {
      return b.quantityOnHand - a.quantityOnHand;
    }
    return a.barcode.localeCompare(b.barcode);
  });
}

function formatTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function sourceLabel(source: InventoryItem['lookupSource'], confidence: number): string {
  const labels: Record<InventoryItem['lookupSource'], string> = {
    upcitemdb: 'UPCitemdb',
    openfoodfacts: 'Open Food Facts',
    web_search: '网页',
    none: '无来源'
  };
  if (source === 'none') {
    return labels[source];
  }
  return `${labels[source]} ${Math.round(confidence * 100)}%`;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
