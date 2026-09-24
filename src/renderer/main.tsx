import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadShopImage } from './shopImage';
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  BadgeCheck,
  Barcode,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FilePlus2,
  FolderOpen,
  GripVertical,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  PackagePlus,
  PackageX,
  Pencil,
  Moon,
  RefreshCw,
  Save,
  ScanBarcode,
  Search,
  SearchX,
  Sheet,
  Sun,
  Trash2,
  UploadCloud,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import './styles.css';
import { CloudPanel } from './CloudPanel';
import { ShopEditor } from './ShopEditor';
import { cardPriceDirty, cardPriceIdentity, keepCardPrice, parseCardPrices, priceDocumentIdentity, receiveCardPrice, receiveCardPrices, startCardPrice, type CardPriceEditor, type PriceDraft } from './cardPriceDraft';
import {
  CloudStatus,
  CurrencyCode,
  ExportFormat,
  InventoryDocument,
  InventoryItem,
  InventoryMode,
  LookupStatus,
  UpdateStatus
} from '../shared/types';

type Notice = { type: 'info' | 'success' | 'warning' | 'error'; text: string };
type ViewMode = 'standard' | 'compact';
type InventoryScope = 'all' | 'outbound' | 'notOutbound';
type ThemeMode = 'light' | 'dark';
type SortPreset = 'name' | 'purchasePrice' | 'salePrice' | 'stock' | 'totalIn' | 'totalOut' | 'recent';
type ValueByCurrency = Partial<Record<CurrencyCode, number>>;
type ActionOptions = { focusBarcode?: boolean; preserveScroll?: boolean; anchorBarcode?: string };
type ScrollSnapshot = { scrollY: number; anchorBarcode?: string; anchorTop?: number };
type ShopSelection = { scope: string; items: { barcode: string; createdAt: string }[] };

const themeStorageKey = 'amane-theme-mode';
const emptyDocument: InventoryDocument = { filePath: null, fileName: '', inventory: null };
const currencyOptions: CurrencyCode[] = ['CAD', 'JPY', 'USD', 'CNY', 'EUR', 'GBP', 'TWD', 'HKD'];
const nameCollator = new Intl.Collator(['zh-Hans-CN', 'zh-CN', 'ja-JP', 'en-US'], {
  numeric: true,
  sensitivity: 'base'
});
const initialThemeMode = readStoredThemeMode();

applyThemeMode(initialThemeMode);

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
  const [storedPrices, setPriceEditors] = useState<Record<string, CardPriceEditor>>({});
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  const [bulkMode, setBulkMode] = useState(false), [shopSelection, setShopSelection] = useState<ShopSelection>({ scope: '', items: [] });
  const [bulkListing, setBulkListing] = useState<boolean | null>(null);
  const bulkConfirmation = useRef<ShopSelection | null>(null), cloudStatusRef = useRef<CloudStatus | null>(null);
  const batchLock = useRef(false);
  const priceWriteLock = useRef(false), documentRef = useRef(document); documentRef.current = document;
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>('standard');
  const [inventoryScope, setInventoryScope] = useState<InventoryScope>('all');
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [hidePurchasePrice, setHidePurchasePrice] = useState(() => localStorage.getItem('amane-hide-purchase-price') === '1');
  const [searchQuery, setSearchQuery] = useState('');
  const [draggingBarcode, setDraggingBarcode] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const inventory = document.inventory;
  const orderedItems = useMemo(() => sortItems(Object.values(inventory?.items ?? {})), [inventory]);
  const priceScope = priceDocumentIdentity(document);
  const priceEditors = receiveCardPrices(storedPrices, priceScope, orderedItems);
  if (priceEditors !== storedPrices) setPriceEditors(priceEditors);
  const priceEditorsRef = useRef(priceEditors); priceEditorsRef.current = priceEditors;
  const priceDrafts = Object.fromEntries(Object.entries(priceEditors).map(([key, value]) => [key, value.draft]));
  const registeredBarcodes = cloudStatus?.inventoryId === inventory?.inventoryId ? cloudStatus?.registeredBarcodes ?? [] : [];
  useEffect(() => {
    let active = true, version = 0; setCloudStatus(null);
    const accept = (status: CloudStatus) => { if (active && (!status.inventoryId || status.inventoryId === inventory?.inventoryId)) { cloudStatusRef.current = status; setCloudStatus(status); } };
    const stop = window.amaneStock.onCloudStatus(status => { version++; accept(status); });
    const requestVersion = version;
    void window.amaneStock.cloudStatus().then(status => { if (version === requestVersion) accept(status); }).catch(() => undefined);
    return () => { active = false; stop(); };
  }, [document.filePath, inventory?.inventoryId]);
  const scopedItems = useMemo(() => filterByInventoryScope(orderedItems, inventoryScope), [orderedItems, inventoryScope]);
  const visibleItems = useMemo(() => filterItems(scopedItems, searchQuery), [scopedItems, searchQuery]);
  const visibleKeys = JSON.stringify(visibleItems.map(item => [item.barcode, item.createdAt]));
  const selectionScope = JSON.stringify([priceScope, cloudStatus?.account?.id ?? null]);
  const selectedShopItems = shopSelection.scope === selectionScope ? shopSelection.items.filter(selected =>
    visibleItems.some(item => item.barcode === selected.barcode && item.createdAt === selected.createdAt)).map(item => item.barcode) : [];
  useEffect(() => { setBulkListing(null); bulkConfirmation.current = null; setBulkMode(false); }, [selectionScope]);
  useEffect(() => {
    setShopSelection(current => ({ scope: selectionScope, items: current.scope === selectionScope ? current.items.filter(selected =>
      visibleItems.some(item => item.barcode === selected.barcode && item.createdAt === selected.createdAt)) : [] }));
    setBulkListing(null); bulkConfirmation.current = null;
  }, [visibleKeys, selectionScope]);
  function selectShopItems(barcodes: string[]): void {
    setShopSelection({ scope: selectionScope, items: barcodes.map(barcode => ({ barcode, createdAt: inventory!.items[barcode]!.createdAt })) });
  }
  function confirmShopListing(listed: boolean): void {
    bulkConfirmation.current = { scope: selectionScope, items: selectedShopItems.map(barcode => ({ barcode, createdAt: inventory!.items[barcode]!.createdAt })) };
    setBulkListing(listed);
  }
  const permissions = cloudStatus?.account?.permissions ?? [];
  const shopActionsEnabled = !!cloudStatus?.connected && !!cloudStatus.account &&
    cloudStatus.shopOperationsSupported === true &&
    permissions.some(permission => permission === 'products.manage' || permission === 'content.manage') &&
    permissions.some(permission => permission === 'inventory.manage' || permission === 'content.manage') &&
    !cloudStatus.shopOperationPending && !cloudStatus.shopPriceConflict &&
    !['conflict', 'expired', 'uploading', 'downloading'].includes(cloudStatus.state);
  function selectionButton(item: InventoryItem): JSX.Element | null {
    if (!bulkMode) return null;
    const selected = selectedShopItems.includes(item.barcode);
    return <button className={`shop-select-item ${selected ? 'selected' : ''}`} type="button" aria-pressed={selected} aria-label={`${selected ? '取消选择' : '选择'} ${item.nickname || item.lookupName || item.barcode}`} disabled={busy || bulkListing !== null} onDragStart={event => event.preventDefault()} onClick={() => selectShopItems(selected ? selectedShopItems.filter(value => value !== item.barcode) : selectedShopItems.length >= 200 ? selectedShopItems : [...selectedShopItems, item.barcode])}><CheckCircle2 size={15} />{selected ? '已选择' : '选择商品'}</button>;
  }
  async function submitShopBatch(): Promise<void> {
    if (batchLock.current || busy || bulkListing === null || !shopActionsEnabled || !selectedShopItems.length || selectedShopItems.length > 200) return;
    const confirmation = bulkConfirmation.current;
    const currentScope = () => JSON.stringify([priceDocumentIdentity(documentRef.current), cloudStatusRef.current?.account?.id ?? null]);
    if (!confirmation || confirmation.scope !== currentScope() || confirmation.items.length !== selectedShopItems.length ||
        confirmation.items.some(item => !selectedShopItems.includes(item.barcode) || documentRef.current.inventory?.items[item.barcode]?.createdAt !== item.createdAt)) {
      setBulkListing(null); bulkConfirmation.current = null; return;
    }
    const barcodes = confirmation.items.map(item => item.barcode), listed = bulkListing, identity = confirmation.scope;
    batchLock.current = true;
    try {
      await runAction(() => window.amaneStock.cloudShopOperation({ type: 'shop-listing-batch', barcodes, listed }), next => {
        if (currentScope() !== identity) return;
        setDocument(next); selectShopItems([]); setBulkListing(null); bulkConfirmation.current = null;
        setNotice({ type: 'success', text: `${barcodes.length} 件商品已${listed ? '上架到' : '从'}次元商店${listed ? '。' : '下架。'}` });
      }, { focusBarcode: false, preserveScroll: true });
    } finally { batchLock.current = false; }
  }
  const totals = useMemo(() => {
    return scopedItems.reduce(
      (acc, item) => {
        const scopedQuantity = inventoryScope === 'outbound' ? item.totalOut : item.quantityOnHand;
        acc.quantity += scopedQuantity;
        acc.in += item.totalIn;
        acc.out += item.totalOut;
        if (item.priceAmount !== null && scopedQuantity > 0) {
          acc.purchaseValueByCurrency[item.priceCurrency] =
            (acc.purchaseValueByCurrency[item.priceCurrency] ?? 0) + item.priceAmount * scopedQuantity;
        }
        if (item.salePriceAmount !== null && scopedQuantity > 0) {
          acc.saleValueByCurrency[item.priceCurrency] =
            (acc.saleValueByCurrency[item.priceCurrency] ?? 0) + item.salePriceAmount * scopedQuantity;
        }
        if (item.priceAmount !== null && item.salePriceAmount !== null && scopedQuantity > 0) {
          acc.grossProfitByCurrency[item.priceCurrency] =
            (acc.grossProfitByCurrency[item.priceCurrency] ?? 0) +
            (item.salePriceAmount - item.priceAmount) * scopedQuantity;
        }
        if (item.salePriceAmount !== null && item.totalOut > 0) {
          acc.outSaleValueByCurrency[item.priceCurrency] =
            (acc.outSaleValueByCurrency[item.priceCurrency] ?? 0) + item.salePriceAmount * item.totalOut;
        }
        if (item.priceAmount !== null && item.totalOut > 0) {
          acc.outCostValueByCurrency[item.priceCurrency] =
            (acc.outCostValueByCurrency[item.priceCurrency] ?? 0) + item.priceAmount * item.totalOut;
        }
        if (item.priceAmount !== null && item.salePriceAmount !== null && item.totalOut > 0) {
          acc.outGrossProfitByCurrency[item.priceCurrency] =
            (acc.outGrossProfitByCurrency[item.priceCurrency] ?? 0) +
            (item.salePriceAmount - item.priceAmount) * item.totalOut;
          acc.outMarginSaleValueByCurrency[item.priceCurrency] =
            (acc.outMarginSaleValueByCurrency[item.priceCurrency] ?? 0) + item.salePriceAmount * item.totalOut;
        }
        return acc;
      },
      {
        quantity: 0,
        in: 0,
        out: 0,
        purchaseValueByCurrency: {} as ValueByCurrency,
        saleValueByCurrency: {} as ValueByCurrency,
        grossProfitByCurrency: {} as ValueByCurrency,
        outSaleValueByCurrency: {} as ValueByCurrency,
        outCostValueByCurrency: {} as ValueByCurrency,
        outGrossProfitByCurrency: {} as ValueByCurrency,
        outMarginSaleValueByCurrency: {} as ValueByCurrency
      }
    );
  }, [inventoryScope, scopedItems]);

  useEffect(() => {
    window.amaneStock.getCurrentInventory().then(setDocument).catch(showError);
    window.amaneStock.getVersion().then(setVersion).catch(() => setVersion('0.1.16'));
    return window.amaneStock.onInventoryChanged((next) => {
      // IPC events may arrive before React commits its next render; confirmation checks use this live identity.
      documentRef.current = next;
      setDocument(next);
    });
  }, []);

  useEffect(() => {
    localStorage.setItem('amane-hide-purchase-price', hidePurchasePrice ? '1' : '0');
  }, [hidePurchasePrice]);

  useEffect(() => {
    storeThemeMode(themeMode);
    applyThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    const nextDrafts = Object.fromEntries(orderedItems.map((item) => [item.barcode, item.nickname]));
    setNicknameDrafts(nextDrafts);
    setQuantityDrafts(Object.fromEntries(orderedItems.map((item) => [item.barcode, String(item.quantityOnHand)])));
  }, [orderedItems]);

  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, [document.filePath, mode]);

  async function runAction<T>(
    action: () => Promise<T>,
    onSuccess?: (result: T) => void,
    options: ActionOptions = {}
  ): Promise<void> {
    const scrollSnapshot = options.preserveScroll ? captureScrollSnapshot(options.anchorBarcode) : null;
    setBusy(true);
    try {
      const result = await action();
      onSuccess?.(result);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      if (scrollSnapshot) {
        restoreScrollSnapshotAfterRender(scrollSnapshot);
      }
      if (options.focusBarcode !== false) {
        window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
      }
    }
  }

  async function runCardAction<T>(
    itemBarcode: string,
    action: () => Promise<T>,
    onSuccess?: (result: T) => void
  ): Promise<void> {
    await runAction(action, onSuccess, {
      focusBarcode: false,
      preserveScroll: true,
      anchorBarcode: itemBarcode
    });
  }

  function showError(error: unknown): void {
    setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
  }

  function setPriceEditor(barcode: string, next: CardPriceEditor): void {
    priceEditorsRef.current = { ...priceEditorsRef.current, [barcode]: next };
    setPriceEditors(current => ({ ...current, [barcode]: next }));
  }
  function currentPriceEditor(item: InventoryItem): { item: InventoryItem; editor: CardPriceEditor; scope: string } | null {
    const doc = documentRef.current, current = doc.inventory?.items[item.barcode], scope = priceDocumentIdentity(doc);
    if (!current || scope !== priceScope || current.createdAt !== item.createdAt) return null;
    return { item: current, editor: receiveCardPrice(priceEditorsRef.current[item.barcode], scope, current), scope };
  }
  function updatePriceDraft(item: InventoryItem, patch: Partial<PriceDraft>): void {
    const current = currentPriceEditor(item); if (!current) return;
    setPriceEditor(item.barcode, { ...current.editor, draft: { ...current.editor.draft, ...patch } });
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

    setBarcode('');
    barcodeInputRef.current?.focus();
    void window.amaneStock
      .submitBarcode(value, mode)
      .then((result) => {
        setDocument(result.document);
        setNotice({ type: result.ok ? 'success' : 'warning', text: result.message });
      })
      .catch(showError)
      .finally(() => barcodeInputRef.current?.focus());
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

    await runCardAction(item.barcode, () => window.amaneStock.updateNickname(item.barcode, draft), (next) => {
      setDocument(next);
      setNotice({ type: 'success', text: '昵称已保存。' });
    });
  }

  async function saveCardPrices(item: InventoryItem, explicit = false): Promise<void> {
    const current = currentPriceEditor(item); if (!current || priceWriteLock.current || busy) return;
    const { editor, scope } = current;
    if (editor.conflict) { setPriceEditor(item.barcode, editor); setNotice({ type: 'warning', text: '价格已在别处变化，当前草稿仍保留。请先选择重新载入或保留草稿。' }); return; }
    if (editor.manual && !explicit) return;
    let purchasePrice: number | null, salePrice: number | null;
    try { ({ purchasePrice, salePrice } = parseCardPrices(editor.draft, current.item)); }
    catch (error) { showError(error); return; }
    if (purchasePrice === current.item.priceAmount && salePrice === current.item.salePriceAmount && editor.draft.currency === current.item.priceCurrency) {
      setPriceEditor(item.barcode, startCardPrice(scope, current.item)); return;
    }
    priceWriteLock.current = true;
    try {
      await runCardAction(item.barcode, () => window.amaneStock.updatePrice(item.barcode, purchasePrice, salePrice, editor.draft.currency), next => {
        if (priceDocumentIdentity(documentRef.current) !== scope) return;
        const saved = next.inventory?.items[item.barcode];
        if (priceDocumentIdentity(next) !== scope || !saved || cardPriceIdentity(scope, saved) !== editor.identity) { setNotice({ type: 'warning', text: '文件或商品已变化，请核对本地记录；未替换当前草稿。' }); return; }
        const pending = priceEditorsRef.current[item.barcode];
        setPriceEditor(item.barcode, pending && JSON.stringify(pending.draft) !== JSON.stringify(editor.draft) ? keepCardPrice(pending, saved) : startCardPrice(scope, saved));
        setDocument(next);
        const currencyNotice = editor.draft.currency !== current.item.priceCurrency ? '货币标签已更新，未执行换汇。' : '';
        setNotice({ type: 'success', text: current.item.priceCurrency === 'CAD' && editor.draft.currency === 'CAD' && salePrice !== null && salePrice !== current.item.salePriceAmount ? `已保存到本地；已连接库存将自动同步商店。${currencyNotice}` : `价格已保存到本地。${salePrice === null ? '售价未定价，不会将商店商品改为免费。' : ''}${currencyNotice}` });
      });
    } finally { priceWriteLock.current = false; }
  }
  async function handlePriceBlur(item: InventoryItem): Promise<void> { await saveCardPrices(item); }
  async function handleCurrencyChange(item: InventoryItem, currency: CurrencyCode): Promise<void> {
    updatePriceDraft(item, { currency });
    await saveCardPrices(item);
  }

  async function handleQuantityBlur(item: InventoryItem): Promise<void> {
    const draft = quantityDrafts[item.barcode] ?? String(item.quantityOnHand);
    const quantity = parseQuantity(draft);
    if (quantity === null) {
      setQuantityDrafts((drafts) => ({ ...drafts, [item.barcode]: String(item.quantityOnHand) }));
      setNotice({ type: 'warning', text: '库存数量必须是大于或等于 0 的整数。' });
      return;
    }
    if (quantity === item.quantityOnHand) {
      return;
    }

    await runCardAction(item.barcode, () => window.amaneStock.updateQuantity(item.barcode, quantity), (next) => {
      setDocument(next);
      setNotice({ type: 'success', text: `当前库存已调整为 ${quantity}，录入和出库累计未改变。` });
    });
  }

  async function handleRefreshLookup(item: InventoryItem): Promise<void> {
    await runCardAction(item.barcode, () => window.amaneStock.refreshLookup(item.barcode), (result) => {
      setDocument(result.document);
      setNotice({ type: result.ok ? 'success' : 'warning', text: result.message });
    });
  }

  async function handleDeleteItem(item: InventoryItem): Promise<void> {
    const name = item.nickname || item.lookupName || item.barcode;
    if (!window.confirm(`删除品类「${name}」？该条码的库存和流水记录都会从当前库存文件移除。`)) {
      return;
    }

    await runCardAction(item.barcode, () => window.amaneStock.deleteItem(item.barcode), (next) => {
      setDocument(next);
      setNicknameDrafts((drafts) => omitKey(drafts, item.barcode));
      setPriceEditors((drafts) => omitKey(drafts, item.barcode));
      setQuantityDrafts((drafts) => omitKey(drafts, item.barcode));
      setNotice({ type: 'success', text: '品类已删除。' });
    });
  }

  async function handleSortPreset(preset: SortPreset): Promise<void> {
    if (!inventory) {
      return;
    }
    const nextOrder = [...orderedItems].sort((a, b) => compareByPreset(a, b, preset)).map((item) => item.barcode);
    await saveSortOrder(nextOrder, '排序已保存。');
  }

  function handleDragStart(event: React.DragEvent<HTMLElement>, item: InventoryItem): void {
    setDraggingBarcode(item.barcode);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.barcode);
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  async function handleDrop(event: React.DragEvent<HTMLElement>, target: InventoryItem): Promise<void> {
    event.preventDefault();
    const draggedBarcode = event.dataTransfer.getData('text/plain') || draggingBarcode;
    setDraggingBarcode(null);
    if (!draggedBarcode || draggedBarcode === target.barcode) {
      return;
    }

    const visibleBarcodes = visibleItems.map((item) => item.barcode);
    if (!visibleBarcodes.includes(draggedBarcode) || !visibleBarcodes.includes(target.barcode)) {
      return;
    }

    const reorderedVisible = moveBefore(visibleBarcodes, draggedBarcode, target.barcode);
    const visibleSet = new Set(visibleBarcodes);
    const visibleQueue = [...reorderedVisible];
    const nextOrder = orderedItems.map((item) => (visibleSet.has(item.barcode) ? visibleQueue.shift() ?? item.barcode : item.barcode));
    await saveSortOrder(nextOrder, '顺序已保存。');
  }

  function handleDragEnd(): void {
    setDraggingBarcode(null);
  }

  async function saveSortOrder(orderedBarcodes: string[], message: string): Promise<void> {
    await runAction(() => window.amaneStock.updateSortOrder(orderedBarcodes), (next) => {
      setDocument(next);
      setNotice({ type: 'success', text: message });
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
    <div className="app-shell" data-theme={themeMode}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Boxes size={22} />
          </div>
          <div className="brand-copy">
            <strong>Amane Stock Manager</strong>
            <span>{version ? `v${version}` : 'v0.1.16'}</span>
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

      <CloudPanel document={document} onDocument={setDocument} />

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

          <div className="summary-stack">
            <div className="summary-row">
              <Metric
                label={inventoryScope === 'outbound' ? '出库数量' : '当前库存'}
                value={totals.quantity}
                icon={inventoryScope === 'outbound' ? <PackageMinus size={18} /> : <PackageCheck size={18} />}
              />
              <Metric label="累计录入" value={totals.in} icon={<PackagePlus size={18} />} />
              <Metric label="累计出库" value={totals.out} icon={<PackageMinus size={18} />} />
              <Metric
                label={inventoryScope === 'outbound' ? '出库成本' : '库存成本'}
                value={hidePurchasePrice ? '已隐藏' : formatValueSummary(totals.purchaseValueByCurrency)}
                icon={hidePurchasePrice ? <EyeOff size={18} /> : <Download size={18} />}
              />
              <Metric
                label={inventoryScope === 'outbound' ? '出库销售额' : '售价估值'}
                value={formatValueSummary(totals.saleValueByCurrency)}
                icon={<BadgeCheck size={18} />}
              />
              <Metric
                label={inventoryScope === 'outbound' ? '出库毛利' : '毛利估算'}
                value={hidePurchasePrice ? '已隐藏' : formatValueSummary(totals.grossProfitByCurrency, false)}
                icon={<ArrowDownWideNarrow size={18} />}
              />
            </div>
            <div className="summary-row sales-summary-row">
              <Metric label="出库销售额" value={formatValueSummary(totals.outSaleValueByCurrency)} icon={<BadgeCheck size={18} />} />
              <Metric
                label="出库成本"
                value={hidePurchasePrice ? '已隐藏' : formatValueSummary(totals.outCostValueByCurrency)}
                icon={hidePurchasePrice ? <EyeOff size={18} /> : <Download size={18} />}
              />
              <Metric
                label="出库毛利率"
                value={
                  hidePurchasePrice
                    ? '已隐藏'
                    : formatMarginSummary(totals.outGrossProfitByCurrency, totals.outMarginSaleValueByCurrency)
                }
                icon={<ArrowDownWideNarrow size={18} />}
              />
            </div>
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
            <div className="view-control" aria-label="显示模式">
              <button type="button" className={viewMode === 'standard' ? 'active' : ''} onClick={() => setViewMode('standard')}>
                标准
              </button>
              <button type="button" className={viewMode === 'compact' ? 'active' : ''} onClick={() => setViewMode('compact')}>
                缩略
              </button>
            </div>
            <button
              type="button"
              className={`theme-toggle ${themeMode === 'dark' ? 'active' : ''}`}
              onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
              aria-pressed={themeMode === 'dark'}
              title={themeMode === 'dark' ? '切换浅色模式' : '切换深色模式'}
            >
              {themeMode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span>{themeMode === 'dark' ? '浅色' : '深色'}</span>
            </button>
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
          <section className="inventory-tools" aria-label="商品检索和排序">
            <label className="search-field">
              <Search size={17} />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索名称、条码、品牌、分类"
                autoComplete="off"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} aria-label="清空搜索">
                  <X size={15} />
                </button>
              )}
            </label>
            <div className="scope-control" aria-label="库存分类视图">
              <button
                type="button"
                className={inventoryScope === 'all' ? 'active' : ''}
                onClick={() => setInventoryScope('all')}
                aria-pressed={inventoryScope === 'all'}
              >
                全部
              </button>
              <button
                type="button"
                className={inventoryScope === 'outbound' ? 'active' : ''}
                onClick={() => setInventoryScope('outbound')}
                aria-pressed={inventoryScope === 'outbound'}
              >
                已出库
              </button>
              <button
                type="button"
                className={inventoryScope === 'notOutbound' ? 'active' : ''}
                onClick={() => setInventoryScope('notOutbound')}
                aria-pressed={inventoryScope === 'notOutbound'}
              >
                未出库
              </button>
            </div>
            <label className={`privacy-toggle ${hidePurchasePrice ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={hidePurchasePrice}
                onChange={(event) => setHidePurchasePrice(event.target.checked)}
              />
              {hidePurchasePrice ? <EyeOff size={16} /> : <Eye size={16} />}
              <span>隐藏进价</span>
            </label>
            <div className="sort-bar" aria-label="排序">
              <button type="button" onClick={() => handleSortPreset('name')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownAZ size={16} />
                <span>名称</span>
              </button>
              <button
                type="button"
                onClick={() => handleSortPreset('purchasePrice')}
                disabled={busy || orderedItems.length < 2 || hidePurchasePrice}
              >
                <ArrowDownWideNarrow size={16} />
                <span>进价</span>
              </button>
              <button type="button" onClick={() => handleSortPreset('salePrice')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownWideNarrow size={16} />
                <span>售价</span>
              </button>
              <button type="button" onClick={() => handleSortPreset('stock')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownWideNarrow size={16} />
                <span>库存</span>
              </button>
              <button type="button" onClick={() => handleSortPreset('totalIn')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownWideNarrow size={16} />
                <span>录入</span>
              </button>
              <button type="button" onClick={() => handleSortPreset('totalOut')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownWideNarrow size={16} />
                <span>出库</span>
              </button>
              <button type="button" onClick={() => handleSortPreset('recent')} disabled={busy || orderedItems.length < 2}>
                <ArrowDownWideNarrow size={16} />
                <span>最近</span>
              </button>
            </div>
            <span className="result-count" title={`全部品类 ${orderedItems.length}`}>
              {visibleItems.length}/{scopedItems.length}
            </span>
          </section>
        )}

        {inventory && orderedItems.length > 0 && <section className="shop-batch-bar" aria-label="批量商店管理">
          <div className="shop-batch-actions">
            <button type="button" disabled={busy} aria-pressed={bulkMode} onClick={() => { setBulkMode(!bulkMode); selectShopItems([]); setBulkListing(null); }}>{bulkMode ? '结束批量选择' : '批量上架 / 下架'}</button>
            {bulkMode && <><span role="status">已选 {selectedShopItems.length} / 200 件 · 仅当前筛选结果</span><button type="button" disabled={busy || bulkListing !== null || visibleItems.length === 0} onClick={() => selectShopItems(visibleItems.slice(0, 200).map(item => item.barcode))}>{visibleItems.length > 200 ? '选择当前前 200 件' : '全选当前结果'}</button><button type="button" disabled={busy || !selectedShopItems.length || bulkListing !== null} onClick={() => selectShopItems([])}>清空选择</button><button type="button" disabled={busy || !shopActionsEnabled || !selectedShopItems.length || bulkListing !== null} onClick={() => confirmShopListing(true)}>批量上架</button><button type="button" disabled={busy || !shopActionsEnabled || !selectedShopItems.length || bulkListing !== null} onClick={() => confirmShopListing(false)}>批量下架</button></>}
          </div>
          {bulkMode && !shopActionsEnabled && <p>{cloudStatus?.connected && cloudStatus.shopOperationsSupported !== true ? '等待 Mac 服务端升级后启用批量上架与主图保存。原有同步和冲突处理仍可使用。' : '请登录并连接当前库存，确认具备库存和商品管理权限，并先处理待同步请求或冲突。'}</p>}
          {bulkMode && selectedShopItems.length === 200 && <p>单次最多选择 200 件，剩余商品可在完成后继续操作。</p>}
          {bulkListing !== null && <div className="shop-batch-confirm" role="group" aria-label="确认批量商店操作"><strong>确认{bulkListing ? '上架' : '下架'}已选的 {selectedShopItems.length} 件商品？</strong><p>{bulkListing ? '未注册的商品会同时在商店注册，保留已有分类和定价；上架后访客可以看到并购买。' : '商品将不再公开展示，库存、图片和订单记录仍保留。'}本次仅操作当前筛选结果中已选择的商品。</p><div className="shop-batch-actions"><button type="button" disabled={busy} onClick={() => setBulkListing(null)}>取消批量操作</button><button type="button" className="shop-batch-submit" disabled={busy || !shopActionsEnabled} onClick={() => void submitShopBatch()}>{busy ? '正在同步…' : `确认批量${bulkListing ? '上架' : '下架'}`}</button></div></div>}
        </section>}

        {inventory && (
          <section className={`inventory-grid ${viewMode === 'compact' ? 'compact-grid' : ''}`} aria-label="库存商品">
            {orderedItems.length === 0 ? (
              <div className="empty-grid">
                <ScanBarcode size={36} />
                <span>暂无商品</span>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="empty-grid">
                <SearchX size={36} />
                <span>{searchQuery.trim() ? '没有匹配商品' : emptyScopeMessage(inventoryScope)}</span>
              </div>
            ) : (
              visibleItems.map((item) =>
                viewMode === 'compact' ? (
                  <article
                    className={`compact-card ${isPrimaryQuantityEmpty(item, inventoryScope) ? 'empty' : ''} ${draggingBarcode === item.barcode ? 'dragging' : ''} ${bulkMode && selectedShopItems.includes(item.barcode) ? 'shop-item-selected' : ''}`}
                    key={item.barcode}
                    data-item-barcode={item.barcode}
                    draggable={!busy}
                    onDragStart={(event) => handleDragStart(event, item)}
                    onDragOver={handleDragOver}
                    onDrop={(event) => handleDrop(event, item)}
                    onDragEnd={handleDragEnd}
                  >
                    {selectionButton(item)}
                    <span className="drag-handle" title="拖动排序">
                      <GripVertical size={16} />
                    </span>
                    <ProductThumb item={item} />
                    <div className="compact-main">
                      <strong>{item.nickname || item.lookupName || item.barcode}</strong>
                      <code>{item.barcode}</code>
                      <span>{item.lookupName || '未识别商品'}</span>
                    </div>
                    <div className="compact-numbers">
                      <strong title={primaryQuantityTitle(inventoryScope)}>{primaryQuantity(item, inventoryScope)}</strong>
                      <span>{hidePurchasePrice ? '进价 已隐藏' : `进价 ${formatPurchasePrice(item)}`}</span>
                      <span>{`售价 ${formatSalePrice(item)}`}</span>
                      <span>
                        {hidePurchasePrice
                          ? `${inventoryScope === 'outbound' ? '出库销售' : '售价库存'} ${formatSaleScopeValue(item, inventoryScope)}`
                          : `毛利 ${formatGrossProfitScopeValue(item, inventoryScope)}`}
                      </span>
                      <button
                        type="button"
                        className="compact-delete"
                        onClick={() => handleDeleteItem(item)}
                        disabled={busy}
                        title="删除品类"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <ShopEditor key={`${priceScope}:${item.barcode}:${item.createdAt}`} item={item} registered={registeredBarcodes.includes(item.barcode)} shopActionsEnabled={shopActionsEnabled} serverSupported={cloudStatus?.shopOperationsSupported === true} disabled={busy} onDocument={setDocument} />
                  </article>
                ) : (
                <article
                  className={`item-card ${isPrimaryQuantityEmpty(item, inventoryScope) ? 'empty' : ''} ${draggingBarcode === item.barcode ? 'dragging' : ''} ${bulkMode && selectedShopItems.includes(item.barcode) ? 'shop-item-selected' : ''}`}
                  key={item.barcode}
                  data-item-barcode={item.barcode}
                  draggable={!busy}
                  onDragStart={(event) => handleDragStart(event, item)}
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleDrop(event, item)}
                  onDragEnd={handleDragEnd}
                >
                  {selectionButton(item)}
                  <div className="item-head">
                    <span className="drag-handle" title="拖动排序">
                      <GripVertical size={17} />
                    </span>
                    <ProductThumb item={item} />
                    <div className="item-title">
                      <h2>{item.nickname || item.lookupName || item.barcode}</h2>
                      <span>{item.lookupName || '未识别商品'}</span>
                    </div>
                    <strong className="quantity" title={primaryQuantityTitle(inventoryScope)}>
                      {primaryQuantity(item, inventoryScope)}
                    </strong>
                  </div>

                  <div className="barcode-line">
                    <Barcode size={16} />
                    <code>{item.barcode}</code>
                  </div>

                  <ShopEditor key={`${priceScope}:${item.barcode}:${item.createdAt}`} item={item} registered={registeredBarcodes.includes(item.barcode)} shopActionsEnabled={shopActionsEnabled} serverSupported={cloudStatus?.shopOperationsSupported === true} disabled={busy} onDocument={setDocument} />

                  <div className="item-edit-row">
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
                    <label
                      className="quantity-field"
                      title="只调整当前库存，不改变累计录入、累计出库或流水记录"
                    >
                      <span>
                        <PackageCheck size={14} />
                        当前库存
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={quantityDrafts[item.barcode] ?? String(item.quantityOnHand)}
                        onChange={(event) =>
                          setQuantityDrafts((drafts) => ({ ...drafts, [item.barcode]: event.target.value }))
                        }
                        onBlur={() => handleQuantityBlur(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        aria-label={`调整 ${item.nickname || item.lookupName || item.barcode} 的当前库存`}
                      />
                    </label>
                  </div>

                  <div className="price-row">
                    {hidePurchasePrice ? (
                      <div className="value-field hidden-price">
                        <span>进价</span>
                        <strong>已隐藏</strong>
                      </div>
                    ) : (
                      <label className="price-field">
                        <span>进价</span>
                        <input
                          value={priceDrafts[item.barcode]?.purchaseAmount ?? ''}
                          disabled={busy}
                          inputMode="decimal"
                          placeholder="0.00"
                          onChange={(event) => updatePriceDraft(item, { purchaseAmount: event.target.value })}
                          onBlur={event => { if (!event.relatedTarget || !event.currentTarget.closest('.price-row')?.contains(event.relatedTarget as Node)) void handlePriceBlur(item); }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </label>
                    )}
                    <label className="price-field">
                      <span>售价</span>
                      <input
                        value={priceDrafts[item.barcode]?.saleAmount ?? ''}
                        disabled={busy}
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(event) => updatePriceDraft(item, { saleAmount: event.target.value })}
                        onBlur={event => { if (!event.relatedTarget || !event.currentTarget.closest('.price-row')?.contains(event.relatedTarget as Node)) void handlePriceBlur(item); }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <label className="currency-field">
                      <span>货币</span>
                      <select
                        value={priceDrafts[item.barcode]?.currency ?? item.priceCurrency}
                        disabled={busy}
                        title="只修改货币标签，不执行换汇"
                        onChange={(event) => handleCurrencyChange(item, event.target.value as CurrencyCode)}
                      >
                        {currencyOptions.map((currency) => (
                          <option key={currency} value={currency}>
                            {currency}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="value-field">
                      <span>{inventoryScope === 'outbound' ? '出库成本' : '库存成本'}</span>
                      <strong>{hidePurchasePrice ? '已隐藏' : formatPurchaseScopeValue(item, inventoryScope)}</strong>
                    </div>
                    <div className="value-field">
                      <span>{inventoryScope === 'outbound' ? '出库销售额' : '售价估值'}</span>
                      <strong>{formatSaleScopeValue(item, inventoryScope)}</strong>
                    </div>
                    <div className="value-field">
                      <span>{inventoryScope === 'outbound' ? '出库毛利' : '毛利估算'}</span>
                      <strong>{hidePurchasePrice ? '已隐藏' : formatGrossProfitScopeValue(item, inventoryScope)}</strong>
                    </div>
                  </div>

                  {priceEditors[item.barcode] && cardPriceDirty(priceEditors[item.barcode]!) && <div className="card-price-draft" role={priceEditors[item.barcode]!.conflict ? 'alert' : 'status'}>
                    {priceEditors[item.barcode]!.conflict ? <><strong>价格记录已变化，未保存的输入仍保留。</strong><p>当前记录：进价 {formatPurchasePrice(item)}，售价 {formatSalePrice(item)}。请先选择如何处理，失去焦点不会覆盖新价格。</p><button type="button" disabled={busy} onClick={() => { const current = currentPriceEditor(item); if (current) setPriceEditor(item.barcode, startCardPrice(current.scope, current.item)); }}>重新载入价格</button><button type="button" disabled={busy} onClick={() => { const current = currentPriceEditor(item); if (current) setPriceEditor(item.barcode, keepCardPrice(current.editor, current.item)); }}>保留草稿继续编辑</button></> : <><span>{priceEditors[item.barcode]!.manual ? '草稿已保留。确认保存后将替换本地记录中的价格。' : '价格有未保存修改。'}</span><button type="button" disabled={busy} onClick={() => void saveCardPrices(item, true)}>保存价格</button><button type="button" disabled={busy} onClick={() => { const current = currentPriceEditor(item); if (current) setPriceEditor(item.barcode, startCardPrice(current.scope, current.item)); }}>放弃修改</button></>}
                  </div>}

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
                    {inventoryScope === 'outbound' && (
                      <span className="stock-pill out">
                        <PackageMinus size={15} />
                        出库 {item.totalOut}
                      </span>
                    )}
                    <button type="button" className="icon-button" onClick={() => handleRefreshLookup(item)} disabled={busy}>
                      <RefreshCw size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => handleDeleteItem(item)}
                      disabled={busy}
                      title="删除品类"
                    >
                      <Trash2 size={15} />
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
                )
              )
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

function Metric({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }): JSX.Element {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProductThumb({ item }: { item: InventoryItem }): JSX.Element {
  const [owned, setOwned] = useState('');
  useEffect(() => {
    let active = true; setOwned('');
    if (item.shop.imageId) void loadShopImage(item.shop.imageId).then(url => { if (active) setOwned(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [item.shop.imageId]);
  const imageUrl = owned || item.imageUrl;
  if (imageUrl) {
    return (
      <div className={`product-thumb ${item.quantityOnHand === 0 ? 'zero' : 'ok'}`}>
        <img src={imageUrl} alt="" loading="lazy" />
      </div>
    );
  }

  return (
    <div className={`product-thumb ${item.quantityOnHand === 0 ? 'zero' : 'ok'}`} aria-hidden="true">
      {item.quantityOnHand === 0 ? <PackageX size={24} /> : <PackageCheck size={24} />}
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

function readStoredThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function storeThemeMode(themeMode: ThemeMode): void {
  try {
    localStorage.setItem(themeStorageKey, themeMode);
  } catch {
    // Theme persistence is best-effort; rendering should continue if storage is unavailable.
  }
}

function applyThemeMode(themeMode: ThemeMode): void {
  globalThis.document.documentElement.dataset.theme = themeMode;
}

function sortItems(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort((a, b) => {
    if (a.sortIndex !== b.sortIndex) {
      return a.sortIndex - b.sortIndex;
    }
    return a.barcode.localeCompare(b.barcode);
  });
}

function filterItems(items: InventoryItem[], query: string): InventoryItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.filter((item) => {
    const haystack = [
      item.barcode,
      item.nickname,
      item.lookupName,
      item.brand,
      item.category,
      item.priceCurrency,
      item.priceAmount === null ? '' : String(item.priceAmount),
      item.salePriceAmount === null ? '' : String(item.salePriceAmount)
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function filterByInventoryScope(items: InventoryItem[], scope: InventoryScope): InventoryItem[] {
  if (scope === 'outbound') {
    return items.filter((item) => item.totalOut > 0);
  }
  if (scope === 'notOutbound') {
    return items.filter((item) => item.totalOut === 0);
  }
  return items;
}

function primaryQuantity(item: InventoryItem, scope: InventoryScope): number {
  return scope === 'outbound' ? item.totalOut : item.quantityOnHand;
}

function isPrimaryQuantityEmpty(item: InventoryItem, scope: InventoryScope): boolean {
  return primaryQuantity(item, scope) === 0;
}

function primaryQuantityTitle(scope: InventoryScope): string {
  return scope === 'outbound' ? '累计出库数量' : '当前库存数量';
}

function emptyScopeMessage(scope: InventoryScope): string {
  if (scope === 'outbound') {
    return '暂无已出库商品';
  }
  if (scope === 'notOutbound') {
    return '暂无未出库商品';
  }
  return '暂无商品';
}

function compareByPreset(a: InventoryItem, b: InventoryItem, preset: SortPreset): number {
  if (preset === 'name') {
    return nameCollator.compare(displayName(a), displayName(b)) || compareManualOrder(a, b);
  }
  if (preset === 'purchasePrice') {
    return comparePriceDescending(a, b, 'purchase') || compareManualOrder(a, b);
  }
  if (preset === 'salePrice') {
    return comparePriceDescending(a, b, 'sale') || compareManualOrder(a, b);
  }
  if (preset === 'stock') {
    return b.quantityOnHand - a.quantityOnHand || compareManualOrder(a, b);
  }
  if (preset === 'totalIn') {
    return b.totalIn - a.totalIn || compareManualOrder(a, b);
  }
  if (preset === 'totalOut') {
    return b.totalOut - a.totalOut || compareManualOrder(a, b);
  }
  return recentOperationTime(b) - recentOperationTime(a) || compareManualOrder(a, b);
}

function displayName(item: InventoryItem): string {
  return item.nickname || item.lookupName || item.barcode;
}

function comparePriceDescending(a: InventoryItem, b: InventoryItem, priceType: 'purchase' | 'sale'): number {
  const aPrice = priceType === 'purchase' ? a.priceAmount : a.salePriceAmount;
  const bPrice = priceType === 'purchase' ? b.priceAmount : b.salePriceAmount;
  if (aPrice === null && bPrice === null) {
    return 0;
  }
  if (aPrice === null) {
    return 1;
  }
  if (bPrice === null) {
    return -1;
  }
  return bPrice - aPrice;
}

function compareManualOrder(a: InventoryItem, b: InventoryItem): number {
  return a.sortIndex - b.sortIndex || a.barcode.localeCompare(b.barcode);
}

function recentOperationTime(item: InventoryItem): number {
  return Math.max(Date.parse(item.lastInAt ?? '') || 0, Date.parse(item.lastOutAt ?? '') || 0);
}

function moveBefore(items: string[], moving: string, target: string): string[] {
  const withoutMoving = items.filter((item) => item !== moving);
  const targetIndex = withoutMoving.indexOf(target);
  if (targetIndex === -1) {
    return items;
  }
  return [...withoutMoving.slice(0, targetIndex), moving, ...withoutMoving.slice(targetIndex)];
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function captureScrollSnapshot(anchorBarcode?: string): ScrollSnapshot {
  const anchor = anchorBarcode ? findItemElement(anchorBarcode) : null;
  return {
    scrollY: window.scrollY,
    anchorBarcode,
    anchorTop: anchor?.getBoundingClientRect().top
  };
}

function restoreScrollSnapshotAfterRender(snapshot: ScrollSnapshot): void {
  const restore = (): void => {
    const anchor = snapshot.anchorBarcode ? findItemElement(snapshot.anchorBarcode) : null;
    const targetScrollY =
      anchor && typeof snapshot.anchorTop === 'number'
        ? window.scrollY + anchor.getBoundingClientRect().top - snapshot.anchorTop
        : snapshot.scrollY;
    const maximumScrollY = Math.max(0, window.document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ left: window.scrollX, top: Math.min(maximumScrollY, Math.max(0, targetScrollY)), behavior: 'auto' });
  };

  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(restore);
  });
}

function findItemElement(barcode: string): HTMLElement | null {
  for (const element of window.document.querySelectorAll<HTMLElement>('[data-item-barcode]')) {
    if (element.dataset.itemBarcode === barcode) {
      return element;
    }
  }
  return null;
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

function parseQuantity(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatPurchasePrice(item: InventoryItem): string {
  if (item.priceAmount === null) {
    return '未定价';
  }
  return `${item.priceCurrency} ${formatNumber(item.priceAmount)}`;
}

function formatSalePrice(item: InventoryItem): string {
  if (item.salePriceAmount === null) {
    return '未定价';
  }
  return `${item.priceCurrency} ${formatNumber(item.salePriceAmount)}`;
}

function formatPurchaseScopeValue(item: InventoryItem, scope: InventoryScope): string {
  if (item.priceAmount === null) {
    return '-';
  }
  return `${item.priceCurrency} ${formatNumber(item.priceAmount * primaryQuantity(item, scope))}`;
}

function formatSaleScopeValue(item: InventoryItem, scope: InventoryScope): string {
  if (item.salePriceAmount === null) {
    return '-';
  }
  return `${item.priceCurrency} ${formatNumber(item.salePriceAmount * primaryQuantity(item, scope))}`;
}

function formatGrossProfitScopeValue(item: InventoryItem, scope: InventoryScope): string {
  if (item.priceAmount === null || item.salePriceAmount === null) {
    return '-';
  }
  return `${item.priceCurrency} ${formatNumber((item.salePriceAmount - item.priceAmount) * primaryQuantity(item, scope))}`;
}

function formatValueSummary(values: ValueByCurrency, positiveOnly = true): string {
  const entries = Object.entries(values).filter(([, value]) =>
    typeof value === 'number' && (positiveOnly ? value > 0 : value !== 0)
  );
  if (entries.length === 0) {
    return '-';
  }
  return entries.map(([currency, value]) => `${currency} ${formatNumber(value ?? 0)}`).join(' / ');
}

function formatMarginSummary(profitValues: ValueByCurrency, saleValues: ValueByCurrency): string {
  const entries = Object.entries(saleValues).filter(
    ([, saleValue]) => typeof saleValue === 'number' && saleValue > 0
  );
  if (entries.length === 0) {
    return '-';
  }
  return entries
    .map(([currency, saleValue]) => {
      const profitValue = profitValues[currency as CurrencyCode] ?? 0;
      return `${currency} ${formatPercent(profitValue / (saleValue ?? 1))}`;
    })
    .join(' / ');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    style: 'percent'
  }).format(value);
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
