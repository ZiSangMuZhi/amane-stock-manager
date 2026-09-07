import { InventoryFile } from '../shared/types';
import { canonicalShop, normalizeBarcode } from '../shared/inventoryLogic';
import { CloudError } from './cloudSync';

/** Validate before allocating an idempotency key so offline corrections never get stuck behind invalid wire bytes. */
export function validateStockSnapshot(inventory: InventoryFile): void {
  function require(condition: boolean, message: string): void { if (!condition) throw new CloudError(message, 400); }
  const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
  const quantity = (value: number) => Number.isInteger(value) && value >= 0 && value <= 1000000000;
  require(inventory.schemaVersion === 7 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inventory.inventoryId), '库存格式或稳定 ID 无效。');
  require(Boolean(inventory.inventoryName.trim()) && inventory.inventoryName.length <= 200, '库存名称需要 1–200 个字符。');
  require(timestamp(inventory.createdAt) && timestamp(inventory.updatedAt), '库存日期无效。');
  require(Object.keys(inventory.items).length <= 10000 && inventory.transactions.length <= 100000, '库存超过 10000 个品类或 100000 条流水限制。');
  for (const [barcode, item] of Object.entries(inventory.items)) {
    require(normalizeBarcode(barcode) === barcode && Boolean(barcode) && item.barcode === barcode, `条码无效：${barcode.slice(0,128)}`);
    require([item.quantityOnHand, item.totalIn, item.totalOut].every(quantity), `商品 ${barcode} 的数量需要是 0–1000000000 的整数。`);
    require(Number.isSafeInteger(item.sortIndex), `商品 ${barcode} 的排序值无效。`);
    require([item.nickname, item.lookupName, item.brand, item.category].every(v => typeof v === 'string' && v.length <= 2000), `商品 ${barcode} 的名称资料过长。`);
    require(!item.imageUrl || (item.imageUrl.length <= 4096 && /^https:\/\//i.test(item.imageUrl)), `商品 ${barcode} 的查询图片需要 HTTPS 地址；可刷新查询修复。`);
    require([item.priceAmount, item.salePriceAmount].every(v => v === null || (Number.isFinite(v) && v >= 0 && v <= 1000000000)), `商品 ${barcode} 的内部金额无效。`);
    require(['CAD','JPY','USD','CNY','EUR','GBP','TWD','HKD'].includes(item.priceCurrency), `商品 ${barcode} 的货币无效。`);
    require(typeof item.listed === 'boolean', `商品 ${barcode} 的上架状态无效。`);
    require(timestamp(item.createdAt) && timestamp(item.updatedAt) && [item.firstInAt, item.lastInAt, item.lastOutAt, item.lookupUpdatedAt].every(v => v === null || timestamp(v)), `商品 ${barcode} 的日期无效。`);
    require(['idle','loading','found','not_found','error'].includes(item.lookupStatus) && ['none','upcitemdb','openfoodfacts','web_search'].includes(item.lookupSource) && Number.isFinite(item.lookupConfidence) && item.lookupConfidence >= 0 && item.lookupConfidence <= 1, `商品 ${barcode} 的查询状态无效。`);
    try { canonicalShop(item.shop); } catch { throw new CloudError(`商品 ${barcode} 的商店定价或图片标识无效。`, 400); }
  }
  const ids = new Set<string>();
  for (const transaction of inventory.transactions) {
    require(typeof transaction.id === 'string' && transaction.id.length > 0 && transaction.id.length <= 128 && !ids.has(transaction.id), '流水 ID 重复或无效。'); ids.add(transaction.id);
    require(Object.hasOwn(inventory.items, transaction.barcode) && quantity(transaction.quantityAfter) && timestamp(transaction.timestamp), '流水引用的商品、数量或日期无效。');
    require(Number.isInteger(transaction.quantityChange) && Math.abs(transaction.quantityChange) <= 1000000000 && (transaction.type === 'in' ? transaction.quantityChange > 0 : transaction.type === 'out' && transaction.quantityChange < 0), '流水方向或数量无效。');
    require([transaction.lookupNameAtTime, transaction.nicknameAtTime].every(v => typeof v === 'string' && v.length <= 2000), '流水名称资料过长。');
  }
}
