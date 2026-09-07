import { useEffect, useState } from 'react';
import { InventoryDocument, InventoryItem, ShopFields } from '../shared/types';

export function ShopEditor({ item, onDocument }: { item: InventoryItem; onDocument: (value: InventoryDocument) => void }): JSX.Element {
  const [draft, setDraft] = useState<ShopFields>(item.shop), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<{ dataUrl: string; width: number; height: number } | null>(null), [ownedUrl, setOwnedUrl] = useState('');
  const [zoom, setZoom] = useState(1), [x, setX] = useState(.5), [y, setY] = useState(.5);
  useEffect(() => { setDraft(item.shop); }, [item.shop]);
  useEffect(() => {
    let active = true; setOwnedUrl('');
    if (item.shop.imageId) void window.amaneStock.getShopImage(item.shop.imageId).then(url => { if (active) setOwnedUrl(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [item.shop.imageId]);
  async function action(work: () => Promise<void>): Promise<void> {
    setBusy(true); setError('');
    const scrollY = window.scrollY;
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' })); }
  }
  const width = selected ? Math.min(selected.width, selected.height) / selected.width / zoom : 1;
  const height = selected ? Math.min(selected.width, selected.height) / selected.height / zoom : 1;
  const crop = { x: (1 - width) * x, y: (1 - height) * y, width, height };
  return <div className="shop-editor" onDragStart={e => e.stopPropagation()}>
    <label className="shop-listing"><input type="checkbox" checked={item.listed} disabled={busy} onChange={e => { const listed = e.target.checked; void action(async () => onDocument(await window.amaneStock.updateListing(item.barcode, listed))); }} />商店上架 <small>{item.listed ? '连接后公开展示' : '不在商店展示'}</small></label>
    <details><summary>商店 CAD 定价 · ${(item.shop.currentCents / 100).toFixed(2)} {item.shop.imageId ? '· 已选图片' : ''}</summary>
      <p>公开零售价格独立于内部进价 / 售价，货币固定为 CAD。</p>
      <div className="shop-price-fields">
        <label>原价 CAD<input type="number" min="0" max="1000000" step="0.01" value={draft.originalCents / 100} onChange={e => setDraft({ ...draft, originalCents: Math.round(Number(e.target.value) * 100) })} /></label>
        <label>计算方式<select value={draft.priceSource} onChange={e => setDraft({ ...draft, priceSource: e.target.value as ShopFields['priceSource'] })}><option value="current">输入现价</option><option value="discount">输入折扣</option></select></label>
        {draft.priceSource === 'current' ? <label>现价 CAD<input type="number" min="0" max={draft.originalCents / 100} step="0.01" value={draft.currentCents / 100} onChange={e => setDraft({ ...draft, currentCents: Math.round(Number(e.target.value) * 100) })} /></label> : <label>减价 %<input type="number" min="0" max="100" step="0.01" value={draft.discountBps / 100} onChange={e => setDraft({ ...draft, discountBps: Math.round(Number(e.target.value) * 100) })} /></label>}
        <button type="button" disabled={busy} onClick={() => void action(async () => onDocument(await window.amaneStock.updateShop(item.barcode, draft)))}>保存商店价格</button>
      </div>
      {ownedUrl && <img className="shop-owned-thumb" src={ownedUrl} alt="已上传的商店图片" />}
      <button type="button" disabled={busy} onClick={() => void action(async () => { setSelected(await window.amaneStock.chooseShopImage()); setZoom(1); setX(.5); setY(.5); })}>选择并裁切自有图片</button>
      {item.shop.imageId && <button type="button" disabled={busy} onClick={() => void action(async () => onDocument(await window.amaneStock.updateShop(item.barcode, { ...item.shop, imageId: null })))}>移除商店图片</button>}
      {selected && <div className="shop-crop">
        <div className="shop-crop-preview"><img draggable={false} src={selected.dataUrl} alt="上传裁切预览" style={{ width: `${100 / width}%`, height: `${100 / height}%`, left: `${-crop.x / width * 100}%`, top: `${-crop.y / height * 100}%` }} /></div>
        <label>缩放<input type="range" min="1" max="4" step="0.01" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
        <label>横向位置<input type="range" min="0" max="1" step="0.01" value={x} onChange={e => setX(Number(e.target.value))} /></label>
        <label>纵向位置<input type="range" min="0" max="1" step="0.01" value={y} onChange={e => setY(Number(e.target.value))} /></label>
        <small>仅上传你拥有或获准使用的图片。此按钮会将裁切图发送到管理员服务，需要先登录。</small>
        <button type="button" disabled={busy} onClick={() => void action(async () => { onDocument(await window.amaneStock.uploadShopImage(item.barcode, selected.dataUrl, crop)); setSelected(null); })}>裁切并上传图片</button>
        <button type="button" disabled={busy} onClick={() => setSelected(null)}>取消</button>
      </div>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </details>
  </div>;
}
