import { useEffect, useRef, useState } from 'react';
import type { InventoryDocument, InventoryItem } from '../shared/types';
import { keepShopPriceDraft, receiveShopPrice, shopFromPriceDraft, shopItemIdentity, shopPriceDirty, startShopPriceEditor, type ShopPriceDraft } from './shopPriceDraft';

type Props = { registered?: boolean; item: InventoryItem; onDocument: (value: InventoryDocument) => void };
export function ShopEditor(props: Props): JSX.Element {
  return <ShopEditorSession key={shopItemIdentity(props.item)} {...props} />;
}
function ShopEditorSession({ item, onDocument, registered = false }: Props): JSX.Element {
  const identity = shopItemIdentity(item), latest = useRef(item); latest.current = item;
  const [stored, setEditor] = useState(() => startShopPriceEditor(identity, item.shop));
  const editor = receiveShopPrice(stored, identity, item.shop);
  if (editor !== stored) setEditor(editor);
  const dirty = shopPriceDirty(editor), editorRef = useRef(editor); editorRef.current = editor;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), locked = useRef(false), container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ dataUrl: string; width: number; height: number } | null>(null), [ownedUrl, setOwnedUrl] = useState('');
  const [zoom, setZoom] = useState(1), [x, setX] = useState(.5), [y, setY] = useState(.5);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true; setOwnedUrl('');
    if (item.shop.imageId) void window.amaneStock.getShopImage(item.shop.imageId).then(url => { if (current) setOwnedUrl(url); }).catch(() => undefined);
    return () => { current = false; };
  }, [item.shop.imageId]);
  let validation = '';
  try { shopFromPriceDraft(editor.draft, item.shop); } catch (cause) { validation = cause instanceof Error ? cause.message : String(cause); }
  function edit(patch: Partial<ShopPriceDraft>): void { setEditor(current => ({ ...current, draft: { ...current.draft, ...patch } })); setError(''); setNotice(''); }
  function accept(document: InventoryDocument, message: string): void {
    if (!active.current) return;
    const saved = document.inventory?.items[item.barcode];
    if (!saved || shopItemIdentity(saved) !== identity) throw new Error('商品或文件已变化，请重新打开此商品后核对。');
    onDocument(document); setNotice(message);
  }
  async function action(work: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const scrollY = window.scrollY, card = container.current?.closest('[data-item-barcode]'), top = card?.getBoundingClientRect().top;
    try { await work(); } catch (cause) { if (active.current) setError(`操作未确认成功，请核对本地记录或重试。价格草稿已保留。${cause instanceof Error ? cause.message : String(cause)}`); }
    finally {
      locked.current = false;
      if (active.current) {
        setBusy(false);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!active.current) return;
          window.scrollTo({ top: card?.isConnected && top !== undefined ? window.scrollY + card.getBoundingClientRect().top - top : scrollY, behavior: 'auto' });
        }));
      }
    }
  }
  async function savePrices(): Promise<void> {
    const current = receiveShopPrice(editorRef.current, identity, latest.current.shop);
    if (current.conflict) { setEditor(current); throw new Error('请先处理外部价格变更。'); }
    const shop = shopFromPriceDraft(current.draft, latest.current.shop);
    const document = await window.amaneStock.updateShop(item.barcode, shop);
    if (!active.current) return;
    const saved = document.inventory?.items[item.barcode];
    if (!saved || shopItemIdentity(saved) !== identity) throw new Error('商品已变化，未重置当前草稿。');
    setEditor(startShopPriceEditor(identity, saved.shop));
    accept(document, '商店价格已保存到本地，等待云同步。');
  }
  const width = selected ? Math.min(selected.width, selected.height) / selected.width / zoom : 1;
  const height = selected ? Math.min(selected.width, selected.height) / selected.height / zoom : 1;
  const crop = { x: (1 - width) * x, y: (1 - height) * y, width, height };
  return <div ref={container} className="shop-editor" onDragStart={e => e.stopPropagation()}>
    <label className="shop-listing"><input type="checkbox" checked={item.listed} disabled={busy || registered} onChange={e => { const listed = e.target.checked; void action(async () => accept(await window.amaneStock.updateListing(item.barcode, listed), '上架设置已保存到本地，等待云同步。')); }} />商店上架 <small>{registered ? '在网页商店管理上架状态' : item.listed ? '连接后公开展示' : '不在商店展示'}</small></label>
    {registered && <p className="shop-price-notice">此商品已在网页商店注册。图片与上架状态请在网页商店管理；此处仍可修改 CAD 定价。</p>}
    <details><summary>商店 CAD 定价 · ${(item.shop.currentCents / 100).toFixed(2)} {item.shop.imageId ? '· 已选图片' : ''}{editor.conflict ? ' · 外部价格变更待处理' : dirty ? ' · 有未保存修改' : ''}</summary>
      <p>商店固定使用 CAD；卡片的 CAD 售价与此处现价同步，进价独立。非 CAD 的卡片售价不参与同步。</p>
      {editor.conflict && <div className="shop-price-conflict" role="alert"><strong>本地记录中的商店价格已变化</strong><p>未保存的输入仍保留。当前记录：原价 CAD {(item.shop.originalCents / 100).toFixed(2)}，现价 CAD {(item.shop.currentCents / 100).toFixed(2)}，减价 {(item.shop.discountBps / 100).toFixed(2)}%。请选择如何处理后再保存。</p><button type="button" disabled={busy} onClick={() => { setEditor(startShopPriceEditor(identity, latest.current.shop)); setError(''); setNotice('已重新载入本地记录中的价格。'); }}>重新载入价格</button><button type="button" disabled={busy} onClick={() => { setEditor(keepShopPriceDraft(editorRef.current, latest.current.shop)); setNotice('草稿已保留，尚未保存。再次保存将替换本地记录中的价格。'); }}>保留草稿继续编辑</button></div>}
      <div className="shop-price-fields">
        <label>原价 CAD<input type="text" inputMode="decimal" maxLength={16} disabled={busy} value={editor.draft.original} onChange={e => edit({ original: e.target.value })} /></label>
        <label>计算方式<select disabled={busy} value={editor.draft.priceSource} onChange={e => edit({ priceSource: e.target.value as ShopPriceDraft['priceSource'] })}><option value="current">输入现价</option><option value="discount">输入折扣</option></select></label>
        {editor.draft.priceSource === 'current' ? <label>现价 CAD<input type="text" inputMode="decimal" maxLength={16} disabled={busy} value={editor.draft.current} onChange={e => edit({ current: e.target.value })} /></label> : <label>减价 %<input type="text" inputMode="decimal" maxLength={16} disabled={busy} value={editor.draft.discount} onChange={e => edit({ discount: e.target.value })} /></label>}
        <button type="button" disabled={busy || !dirty || !!validation || editor.conflict} onClick={() => void action(savePrices)}>保存商店价格</button>
      </div>
      {dirty && validation && <p className="shop-price-validation" role="status">{validation}</p>}
      {dirty && !editor.conflict && <button type="button" disabled={busy} onClick={() => { setEditor(startShopPriceEditor(identity, latest.current.shop)); setError(''); setNotice('未保存的价格修改已放弃。'); }}>放弃价格修改</button>}
      {ownedUrl && <img className="shop-owned-thumb" src={ownedUrl} alt="已上传的商店图片" />}
      {!registered && <button type="button" disabled={busy} onClick={() => void action(async () => { const chosen = await window.amaneStock.chooseShopImage(); if (active.current) { setSelected(chosen); setZoom(1); setX(.5); setY(.5); } })}>选择并裁切自有图片</button>}
      {!registered && item.shop.imageId && <button type="button" disabled={busy} onClick={() => void action(async () => accept(await window.amaneStock.updateShop(item.barcode, { ...latest.current.shop, imageId: null }), '图片移除已保存到本地，等待云同步。未保存的价格草稿未提交。'))}>移除商店图片</button>}
      {!registered && selected && <div className="shop-crop">
        <div className="shop-crop-preview"><img draggable={false} src={selected.dataUrl} alt="上传裁切预览" style={{ width: `${100 / width}%`, height: `${100 / height}%`, left: `${-crop.x / width * 100}%`, top: `${-crop.y / height * 100}%` }} /></div>
        <label>缩放<input type="range" min="1" max="4" step="0.01" disabled={busy} value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
        <label>横向位置<input type="range" min="0" max="1" step="0.01" disabled={busy} value={x} onChange={e => setX(Number(e.target.value))} /></label>
        <label>纵向位置<input type="range" min="0" max="1" step="0.01" disabled={busy} value={y} onChange={e => setY(Number(e.target.value))} /></label>
        <small>仅上传你拥有或获准使用的图片。此按钮会将裁切图发送到管理员服务，需要先登录；不会提交未保存的价格。</small>
        <button type="button" disabled={busy} onClick={() => void action(async () => { const document = await window.amaneStock.uploadShopImage(item.barcode, selected.dataUrl, crop); if (active.current) { accept(document, '图片关联已保存到本地，等待云同步。未保存的价格草稿未提交。'); setSelected(null); } })}>裁切并上传图片</button>
        <button type="button" disabled={busy} onClick={() => setSelected(null)}>取消</button>
      </div>}
      {notice && <p className="shop-price-notice" role="status">{notice}</p>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </details>
  </div>;
}
