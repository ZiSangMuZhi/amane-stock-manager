import { canonicalShop } from '../shared/inventoryLogic';
import type { InventoryItem, ShopFields } from '../shared/types';

export type ShopPriceDraft = { original: string; current: string; discount: string; priceSource: ShopFields['priceSource'] };
export type ShopPriceEditor = { identity: string; baseline: ShopFields; observed: string; draft: ShopPriceDraft; conflict: boolean };
export const shopItemIdentity = (item: Pick<InventoryItem, 'barcode' | 'createdAt'>): string => JSON.stringify([item.barcode, item.createdAt]);
export const shopPriceSignature = (shop: ShopFields): string => JSON.stringify([shop.originalCents, shop.currentCents, shop.discountBps, shop.priceSource]);
const priceDraft = (shop: ShopFields): ShopPriceDraft => ({ original: (shop.originalCents / 100).toFixed(2), current: (shop.currentCents / 100).toFixed(2), discount: (shop.discountBps / 100).toFixed(2), priceSource: shop.priceSource });
export function startShopPriceEditor(identity: string, shop: ShopFields): ShopPriceEditor {
  return { identity, baseline: shop, observed: shopPriceSignature(shop), draft: priceDraft(shop), conflict: false };
}
function decimalHundredths(value: string, maximum: number, label: string): number {
  const text = value.trim();
  if (!text) throw new Error(`请输入${label}。`);
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) throw new Error(`${label}须为非负数字，最多两位小数。`);
  const [whole = '', fraction = ''] = text.split('.');
  const amount = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > maximum) throw new Error(`${label}不能超过 ${maximum / 100}。`);
  return amount;
}
/** Prices come from validated input; the image comes from the newest persisted item. */
export function shopFromPriceDraft(draft: ShopPriceDraft, latest: ShopFields): ShopFields {
  const originalCents = decimalHundredths(draft.original, 100_000_000, '原价');
  const currentCents = draft.priceSource === 'current' ? decimalHundredths(draft.current, 100_000_000, '现价') : 0;
  const discountBps = draft.priceSource === 'discount' ? decimalHundredths(draft.discount, 10_000, '减价百分比') : 0;
  if (draft.priceSource === 'current' && currentCents > originalCents) throw new Error('现价不能高于原价。');
  return canonicalShop({ imageId: latest.imageId, originalCents, currentCents, discountBps, priceSource: draft.priceSource });
}
export function shopPriceDirty(editor: ShopPriceEditor): boolean {
  // Even an unfinished or merely reformatted value must survive background refresh.
  return JSON.stringify(editor.draft) !== JSON.stringify(priceDraft(editor.baseline));
}
export function receiveShopPrice(editor: ShopPriceEditor, identity: string, latest: ShopFields): ShopPriceEditor {
  const signature = shopPriceSignature(latest);
  if (editor.identity !== identity) return startShopPriceEditor(identity, latest);
  if (editor.observed === signature) return editor;
  if (!shopPriceDirty(editor)) return startShopPriceEditor(identity, latest);
  return { ...editor, observed: signature, conflict: signature !== shopPriceSignature(editor.baseline) };
}
/** Explicit acknowledgement keeps the draft; it never saves it automatically. */
export function keepShopPriceDraft(editor: ShopPriceEditor, latest: ShopFields): ShopPriceEditor {
  return { ...editor, baseline: latest, observed: shopPriceSignature(latest), conflict: false };
}
