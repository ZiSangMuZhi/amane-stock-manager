import type { CurrencyCode, InventoryDocument, InventoryItem } from '../shared/types';
export type PriceDraft = { purchaseAmount: string; saleAmount: string; currency: CurrencyCode };
export type CardPriceEditor = { identity: string; baseline: PriceDraft; observed: string; draft: PriceDraft; conflict: boolean; manual: boolean };
export const priceDocumentIdentity = (document: InventoryDocument): string => JSON.stringify([document.filePath, document.inventory?.inventoryId]);
export const cardPriceIdentity = (scope: string, item: InventoryItem): string => JSON.stringify([scope, item.barcode, item.createdAt]);
export const priceDraftFromItem = (item: InventoryItem): PriceDraft => ({ purchaseAmount: item.priceAmount === null ? '' : String(item.priceAmount), saleAmount: item.salePriceAmount === null ? '' : String(item.salePriceAmount), currency: item.priceCurrency });
export const cardPriceDirty = (editor: CardPriceEditor): boolean => JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline);
export function startCardPrice(scope: string, item: InventoryItem): CardPriceEditor {
  const draft = priceDraftFromItem(item);
  return { identity: cardPriceIdentity(scope, item), baseline: draft, observed: JSON.stringify(draft), draft, conflict: false, manual: false };
}
export function receiveCardPrice(editor: CardPriceEditor | undefined, scope: string, item: InventoryItem): CardPriceEditor {
  const next = startCardPrice(scope, item);
  if (!editor || editor.identity !== next.identity) return next;
  if (editor.observed === next.observed) return editor;
  if (!cardPriceDirty(editor)) return next;
  return { ...editor, observed: next.observed, conflict: next.observed !== JSON.stringify(editor.baseline) };
}
export function receiveCardPrices(editors: Record<string, CardPriceEditor>, scope: string, items: InventoryItem[]): Record<string, CardPriceEditor> {
  const next = Object.fromEntries(items.map(item => [item.barcode, receiveCardPrice(editors[item.barcode], scope, item)]));
  return Object.keys(editors).length === items.length && items.every(item => next[item.barcode] === editors[item.barcode]) ? editors : next;
}
export function keepCardPrice(editor: CardPriceEditor, item: InventoryItem): CardPriceEditor {
  const baseline = priceDraftFromItem(item);
  return { ...editor, baseline, observed: JSON.stringify(baseline), conflict: false, manual: true };
}
export function parseCardPrice(text: string, label: string): number | null {
  const value = text.trim();
  if (!value) return null; // Unpriced is not a free item.
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) throw new Error(`${label}须为非负数字，最多两位小数；留空表示未定价。`);
  const result = Number(value);
  if (!Number.isFinite(result) || result > 1_000_000_000) throw new Error(`${label}不能超过 1000000000。`);
  return result;
}
export function parseCardPrices(draft: PriceDraft, item: InventoryItem): { purchasePrice: number | null; salePrice: number | null } {
  const purchasePrice = parseCardPrice(draft.purchaseAmount, '进价'), salePrice = parseCardPrice(draft.saleAmount, '售价');
  // Match updatePrice: changing the currency label alone does not publish a shop price.
  if (item.priceCurrency === 'CAD' && draft.currency === 'CAD' && salePrice !== null && salePrice !== item.salePriceAmount && salePrice > 1_000_000) throw new Error('同步到商店的 CAD 售价不能超过 1000000。');
  return { purchasePrice, salePrice };
}
