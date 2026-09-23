import { randomUUID } from 'node:crypto';
import { canonicalShop } from '../shared/inventoryLogic';
import type { InventoryFile, ShopFields, StockRecord } from '../shared/types';
import { CloudError, type SyncJournal } from './cloudSync';

export type ShopPrice = Omit<ShopFields, 'imageId'>;
export type ShopProduct = {
  id: string; version: number; sourceBookId: string | null; sourceBarcode: string | null;
  shopRegistered: boolean; deletedAt: string | null; listed?: boolean; stock?: number;
  content: ShopPrice & { name: string; imageId: string | null; currency: 'CAD'; categoryId?: string | null };
};
export type ShopProductPriceRequest = {
  version: number; requestKey: string; content: Omit<ShopProduct['content'], 'categoryId'>;
};
export interface ShopPriceTransport {
  stock(id: string): Promise<StockRecord>;
  products(): Promise<ShopProduct[]>;
  product(id: string): Promise<ShopProduct>;
  /** The write-ahead body must reach the transport unchanged, including on retry. */
  saveProductPrice(id: string, body: string): Promise<ShopProduct>;
}
export interface ShopPriceIntent {
  /** Empty only for a candidate registered concurrently with the acknowledged stock PUT. */
  inventoryId: string; barcode: string; productId: string; base: ShopPrice; desired: ShopPrice;
  request?: { requestKey: string; version: number; body: string };
}
export type ShopPriceCandidate = Omit<ShopPriceIntent, 'productId' | 'request'>;
export interface PreparedShopPrices { intents: ShopPriceIntent[]; candidates: ShopPriceCandidate[] }

/** Kept separate from stock conflicts: choosing a cloud inventory cannot resolve a product write. */
export class ShopPriceSyncError extends Error {
  constructor(message: string, readonly status = 0, readonly conflict = false) { super(message); }
}

export function shopPrice(value: ShopPrice): ShopPrice {
  const { originalCents, currentCents, discountBps, priceSource } = canonicalShop({ ...value, imageId: null });
  return { originalCents, currentCents, discountBps, priceSource };
}
export function sameShopPrice(a: ShopPrice, b: ShopPrice): boolean {
  return JSON.stringify(shopPrice(a)) === JSON.stringify(shopPrice(b));
}

function priceError(error: unknown): ShopPriceSyncError {
  if (error instanceof ShopPriceSyncError) return error;
  const status = error instanceof CloudError ? error.status : 0;
  const detail = status === 409 ? '商店价格冲突，请选择保留商店价格或重新应用本地价格。'
    : [404, 410].includes(status) ? '商店商品已删除或不存在，请先在商店管理中检查商品。'
    : status === 401 ? '登录已过期，请重新登录后继续商店价格同步。'
    : status === 403 ? '账号没有商店商品或价格管理权限，待发价格已保留。'
    : status ? `商店价格服务暂时失败（${status}），待发价格已保留，请重试。`
    : '商店价格同步中断，待发价格已保留，请重试。';
  return new ShopPriceSyncError(`库存已同步，${detail}`, status, status === 409);
}

function validateProduct(product: ShopProduct, intent: ShopPriceIntent): void {
  if (product.deletedAt) throw new ShopPriceSyncError('库存已同步，商店商品已删除，请先在商店管理中检查商品。', 410);
  if (product.id !== intent.productId || product.sourceBookId !== intent.inventoryId ||
      product.sourceBarcode !== intent.barcode || !product.shopRegistered ||
      !Number.isSafeInteger(product.version) || product.version < 1 || product.content.currency !== 'CAD') {
    throw new ShopPriceSyncError('库存已同步，商店商品绑定已改变，已保留待发价格。', 409, true);
  }
  shopPrice(product.content);
}

async function bindCandidate(intent: ShopPriceIntent, transport: ShopPriceTransport): Promise<ShopPriceIntent> {
  if (intent.productId) return intent;
  const matches = (await transport.products()).filter(product => product.sourceBookId === intent.inventoryId &&
    product.sourceBarcode === intent.barcode && product.shopRegistered && !product.deletedAt);
  if (matches.length !== 1) throw new ShopPriceSyncError('库存已同步，新注册的商店商品已删除或绑定改变，待发价格已保留。', 410);
  const bound = { ...intent, productId: matches[0]!.id };
  validateProduct(matches[0]!, bound);
  return bound;
}

/** Capture price edits against the exact stock version before its idempotent PUT is created. */
export async function prepareShopPrices(local: InventoryFile, version: number, transport: ShopPriceTransport): Promise<PreparedShopPrices> {
  const previous = await transport.stock(local.inventoryId);
  if (previous.id !== local.inventoryId || previous.inventory?.inventoryId !== local.inventoryId || previous.inventory.schemaVersion !== 7) {
    throw new CloudError('服务器返回了不匹配的库存，未准备价格同步。', 502);
  }
  if (previous.version !== version) throw new CloudError('准备商店价格时云端库存版本已变化。', 409);
  const registered = previous.shopRegisteredBarcodes && new Set(previous.shopRegisteredBarcodes);
  const changed = Object.values(local.items).filter(item => {
    const old = previous.inventory.items[item.barcode];
    return old && !sameShopPrice(old.shop, item.shop);
  });
  if (!changed.length) return { intents: [], candidates: [] };
  // Inventory-only accounts do not need product permissions unless a price was actually edited.
  const products = changed.some(item => !registered || registered.has(item.barcode)) ? await transport.products() : [];
  const intents: ShopPriceIntent[] = [];
  const candidates: ShopPriceCandidate[] = [];
  for (const item of changed) {
    const matches = products.filter(product => product.sourceBookId === local.inventoryId && product.sourceBarcode === item.barcode && product.shopRegistered && !product.deletedAt);
    if (matches.length > 1) throw new CloudError('商店商品绑定重复，已停止同步，请在后台检查。', 502);
    const product = matches[0];
    if (!product) {
      if (registered?.has(item.barcode)) throw new CloudError('已注册的商店商品已删除或绑定改变，本次库存与价格尚未提交，请先在后台检查。', 410);
      // Registration may happen between this GET and the stock PUT. Keep the old inventory price
      // as the baseline; accepting a later managed price as the baseline would silently overwrite it.
      candidates.push({ inventoryId: local.inventoryId, barcode: item.barcode,
        base: shopPrice(previous.inventory.items[item.barcode]!.shop), desired: shopPrice(item.shop) });
      continue;
    }
    const intent = { inventoryId: local.inventoryId, barcode: item.barcode, productId: product.id,
      base: shopPrice(product.content), desired: shopPrice(item.shop) };
    validateProduct(product, intent);
    if (!sameShopPrice(intent.base, intent.desired)) intents.push(intent);
  }
  return { intents, candidates };
}

/** Save before mutating the in-memory journal, so a failed disk write cannot discard a request. */
export async function checkpointShopPrices(journal: SyncJournal, next: SyncJournal, save: (value: SyncJournal) => Promise<void>): Promise<void> {
  await save(next);
  Object.assign(journal, next);
}

export async function flushShopPrices(journal: SyncJournal, transport: ShopPriceTransport,
  save: (value: SyncJournal) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  try {
    while (journal.shopPricePending?.length && !stopped()) {
      let intent = journal.shopPricePending[0]!;
      if (intent.inventoryId !== journal.inventoryId) throw new ShopPriceSyncError('商店价格所属库存已改变，已停止同步。', 409, true);
      if (!intent.productId) {
        intent = await bindCandidate(intent, transport);
        await checkpointShopPrices(journal, { ...journal, shopPricePending: [intent, ...journal.shopPricePending.slice(1)] }, save);
      }
      if (!intent.request) {
        const product = await transport.product(intent.productId);
        validateProduct(product, intent);
        if (!sameShopPrice(product.content, intent.desired)) {
          if (!sameShopPrice(product.content, intent.base)) throw new ShopPriceSyncError('库存已同步，商店价格冲突，请选择保留商店价格或重新应用本地价格。', 409, true);
          const requestKey = randomUUID();
          // Use current managed presentation fields. Omitted categoryId preserves the server category.
          const payload: ShopProductPriceRequest = { version: product.version, requestKey, content: {
            name: product.content.name, imageId: product.content.imageId, currency: 'CAD', ...intent.desired
          } };
          intent = { ...intent, request: { version: product.version, requestKey, body: JSON.stringify(payload) } };
          await checkpointShopPrices(journal, { ...journal, shopPricePending: [intent, ...journal.shopPricePending.slice(1)] }, save);
        }
      }
      if (stopped()) return;
      if (intent.request) {
        // A lost response is replayed verbatim. A new GET/version would break idempotency.
        const result = await transport.saveProductPrice(intent.productId, intent.request.body);
        validateProduct(result, intent);
        if (!sameShopPrice(result.content, intent.desired)) throw new ShopPriceSyncError('库存已同步，商店返回的价格不匹配，待发请求已保留。', 502);
      }
      await checkpointShopPrices(journal, { ...journal, shopPricePending: journal.shopPricePending.slice(1), shopPriceConflict: false }, save);
    }
  } catch (error) { throw priceError(error); }
}

/** Explicit user resolution is the only operation allowed to rebase a conflicting price request. */
export async function readShopPriceResolution(intents: ShopPriceIntent[], transport: ShopPriceTransport): Promise<{ intent: ShopPriceIntent; price: ShopPrice }[]> {
  try {
    const resolved: { intent: ShopPriceIntent; price: ShopPrice }[] = [];
    for (const pending of intents) {
      const intent = await bindCandidate(pending, transport);
      const product = await transport.product(intent.productId);
      validateProduct(product, intent);
      resolved.push({ intent, price: shopPrice(product.content) });
    }
    return resolved;
  } catch (error) { throw priceError(error); }
}
