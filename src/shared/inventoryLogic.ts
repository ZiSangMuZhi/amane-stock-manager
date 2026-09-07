import {
  InventoryFile,
  InventoryItem,
  InventoryMode,
  ProductLookupResult,
  ShopFields,
  SCHEMA_VERSION,
  SubmitBarcodeResult
} from './types';

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeBarcode(raw: string): string {
  if (typeof raw !== 'string') throw new Error('条码必须是文字。');
  const value = raw.replace(/[\r\n\t]/g, '').trim();
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('条码包含无效字符或过长。');
  return value;
}

export function createInventory(inventoryName: string, createdAt = nowIso()): InventoryFile {
  if (!inventoryName.trim() || inventoryName.length > 200) throw new Error('库存名称需要 1–200 个字符。');
  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryId: crypto.randomUUID(),
    inventoryName,
    createdAt,
    updatedAt: createdAt,
    items: {},
    transactions: []
  };
}

export function createInventoryItem(barcode: string, timestamp = nowIso()): InventoryItem {
  return {
    listed: false,
    shop: emptyShop(),
    barcode,
    sortIndex: 0,
    nickname: '',
    lookupName: '',
    brand: '',
    category: '',
    imageUrl: '',
    priceAmount: null,
    salePriceAmount: null,
    priceCurrency: 'CAD',
    lookupSource: 'none',
    lookupConfidence: 0,
    quantityOnHand: 0,
    totalIn: 0,
    totalOut: 0,
    firstInAt: null,
    lastInAt: null,
    lastOutAt: null,
    lookupStatus: 'idle',
    lookupUpdatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function cloneInventory(inventory: InventoryFile): InventoryFile {
  return {
    ...inventory,
    items: Object.fromEntries(
      Object.entries(inventory.items).map(([barcode, item]) => [barcode, { ...item, shop: { ...item.shop } }])
    ),
    transactions: inventory.transactions.map((transaction) => ({ ...transaction }))
  };
}

export function emptyShop(): ShopFields {
  return { imageId: null, originalCents: 0, currentCents: 0, discountBps: 0, priceSource: 'discount' };
}

export function canonicalShop(shop: ShopFields): ShopFields {
  if (!shop || !['current', 'discount'].includes(shop.priceSource) ||
      ![shop.originalCents, shop.currentCents, shop.discountBps].every(Number.isSafeInteger) ||
      shop.originalCents < 0 || shop.originalCents > 100000000 || shop.currentCents < 0 || shop.currentCents > 100000000 ||
      (shop.priceSource === 'current' && shop.currentCents > shop.originalCents) || shop.discountBps < 0 || shop.discountBps > 10000 ||
      (shop.imageId !== null && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(shop.imageId))) {
    throw new Error('商店价格需要有效的 CAD 分金额、0–100% 折扣以及已上传图片。');
  }
  return { ...shop,
    currentCents: shop.priceSource === 'discount' ? Math.round(shop.originalCents * (10000 - shop.discountBps) / 10000) : shop.currentCents,
    discountBps: !shop.originalCents ? 0 : shop.priceSource === 'current' ? Math.round((shop.originalCents - shop.currentCents) * 10000 / shop.originalCents) : shop.discountBps
  };
}

export function updateListing(inventory: InventoryFile, barcode: string, listed: boolean): InventoryFile {
  if (typeof listed !== 'boolean') throw new Error('无效的上架状态。');
  const next = cloneInventory(inventory);
  const item = next.items[normalizeBarcode(barcode)];
  if (!item) return inventory;
  item.listed = listed;
  item.updatedAt = next.updatedAt = nowIso();
  return next;
}

export function updateShop(inventory: InventoryFile, barcode: string, shop: ShopFields): InventoryFile {
  const normalized = canonicalShop(shop);
  const next = cloneInventory(inventory);
  const item = next.items[normalizeBarcode(barcode)];
  if (!item) return inventory;
  item.shop = normalized;
  item.updatedAt = next.updatedAt = nowIso();
  return next;
}

export function submitBarcode(
  inventory: InventoryFile,
  rawBarcode: string,
  mode: InventoryMode,
  timestamp = nowIso(),
  idFactory = cryptoRandomId
): { ok: boolean; message: string; inventory: InventoryFile; item?: InventoryItem } {
  if (mode !== 'in' && mode !== 'out') throw new Error('无效的库存模式。');
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode) {
    return { ok: false, message: '条码不能为空。', inventory };
  }

  const existing = inventory.items[barcode];
  if (inventory.transactions.length >= 100000 || (!existing && Object.keys(inventory.items).length >= 10000)) throw new Error('库存已达到 10000 个品类或 100000 条流水上限。');
  if (existing && ((mode === 'in' && (existing.quantityOnHand >= 1000000000 || existing.totalIn >= 1000000000)) || (mode === 'out' && existing.totalOut >= 1000000000))) throw new Error('数量已达到允许上限。');
  if (mode === 'out' && (!existing || existing.quantityOnHand <= 0)) {
    return { ok: false, message: `库存为 0，已阻止出库：${barcode}`, inventory };
  }

  const next = cloneInventory(inventory);
  const item = next.items[barcode] ?? createInventoryItem(barcode, timestamp);
  if (!next.items[barcode]) {
    item.sortIndex = nextTopSortIndex(next);
  }

  if (mode === 'in') {
    item.quantityOnHand += 1;
    item.totalIn += 1;
    item.firstInAt ??= timestamp;
    item.lastInAt = timestamp;
  } else {
    item.quantityOnHand -= 1;
    item.totalOut += 1;
    item.lastOutAt = timestamp;
  }

  item.updatedAt = timestamp;
  next.items[barcode] = item;
  next.transactions.unshift({
    id: idFactory(),
    barcode,
    type: mode,
    timestamp,
    quantityChange: mode === 'in' ? 1 : -1,
    quantityAfter: item.quantityOnHand,
    lookupNameAtTime: item.lookupName,
    nicknameAtTime: item.nickname
  });
  next.updatedAt = timestamp;

  return {
    ok: true,
    message: mode === 'in' ? `已录入：${barcode}` : `已出库：${barcode}`,
    inventory: next,
    item
  };
}

export function updateNickname(
  inventory: InventoryFile,
  rawBarcode: string,
  nickname: string,
  timestamp = nowIso()
): InventoryFile {
  if (typeof nickname !== 'string' || nickname.length > 2000) throw new Error('昵称长度不能超过 2000。');
  const barcode = normalizeBarcode(rawBarcode);
  const next = cloneInventory(inventory);
  const item = next.items[barcode];
  if (!item) {
    return inventory;
  }
  item.nickname = nickname.trim();
  item.updatedAt = timestamp;
  next.items[barcode] = item;
  next.updatedAt = timestamp;
  return next;
}

export function updatePrice(
  inventory: InventoryFile,
  rawBarcode: string,
  purchasePriceAmount: number | null,
  salePriceAmount: number | null,
  priceCurrency: InventoryItem['priceCurrency'],
  timestamp = nowIso()
): InventoryFile {
  if (!['CAD', 'JPY', 'USD', 'CNY', 'EUR', 'GBP', 'TWD', 'HKD'].includes(priceCurrency)) throw new Error('无效的货币。');
  const barcode = normalizeBarcode(rawBarcode);
  const next = cloneInventory(inventory);
  const item = next.items[barcode];
  if (!item) {
    return inventory;
  }
  item.priceAmount = normalizePriceAmount(purchasePriceAmount);
  item.salePriceAmount = normalizePriceAmount(salePriceAmount);
  item.priceCurrency = priceCurrency;
  item.updatedAt = timestamp;
  next.items[barcode] = item;
  next.updatedAt = timestamp;
  return next;
}

export function updateQuantityOnHand(
  inventory: InventoryFile,
  rawBarcode: string,
  quantityOnHand: number,
  timestamp = nowIso()
): InventoryFile {
  if (!Number.isSafeInteger(quantityOnHand) || quantityOnHand < 0 || quantityOnHand > 1000000000) {
    throw new Error('库存数量必须是大于或等于 0 的整数。');
  }

  const barcode = normalizeBarcode(rawBarcode);
  const next = cloneInventory(inventory);
  const item = next.items[barcode];
  if (!item) {
    return inventory;
  }

  item.quantityOnHand = quantityOnHand;
  item.updatedAt = timestamp;
  next.items[barcode] = item;
  next.updatedAt = timestamp;
  return next;
}

export function deleteInventoryItem(
  inventory: InventoryFile,
  rawBarcode: string,
  timestamp = nowIso()
): InventoryFile {
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode || !inventory.items[barcode]) {
    return inventory;
  }

  const next = cloneInventory(inventory);
  delete next.items[barcode];
  next.transactions = next.transactions.filter((transaction) => transaction.barcode !== barcode);
  next.updatedAt = timestamp;
  return next;
}

export function updateSortOrder(
  inventory: InventoryFile,
  orderedBarcodes: string[],
  timestamp = nowIso()
): InventoryFile {
  const next = cloneInventory(inventory);
  const uniqueOrdered = [...new Set(orderedBarcodes.map(normalizeBarcode))].filter((barcode) => barcode in next.items);
  const remaining = Object.values(next.items)
    .filter((item) => !uniqueOrdered.includes(item.barcode))
    .sort((a, b) => compareSortIndex(a, b))
    .map((item) => item.barcode);

  [...uniqueOrdered, ...remaining].forEach((barcode, index) => {
    const item = next.items[barcode];
    if (item) {
      item.sortIndex = index;
    }
  });
  next.updatedAt = timestamp;
  return next;
}

export function applyLookupResult(
  inventory: InventoryFile,
  lookup: ProductLookupResult
): InventoryFile {
  const next = cloneInventory(inventory);
  const timestamp = lookup.lookedUpAt;
  const item = next.items[lookup.barcode];
  if (!item) {
    return inventory;
  }

  item.lookupStatus = lookup.status;
  item.lookupUpdatedAt = timestamp;
  if (lookup.status === 'found') {
    item.lookupName = lookup.productName;
    item.brand = lookup.brand;
    item.category = lookup.category;
    item.imageUrl = /^https?:\/\//i.test(lookup.imageUrl) ? lookup.imageUrl.replace(/^http:/i, 'https:') : '';
  }
  item.lookupSource = lookup.source;
  item.lookupConfidence = lookup.confidence;

  item.updatedAt = timestamp;
  next.items[lookup.barcode] = item;
  next.updatedAt = timestamp;
  return next;
}

export function shouldLookup(item: InventoryItem | undefined): boolean {
  return !item || item.lookupStatus === 'idle' || item.lookupStatus === 'not_found' || item.lookupStatus === 'error';
}

export function toSubmitResult(
  ok: boolean,
  message: string,
  document: { filePath: string | null; fileName: string; inventory: InventoryFile | null },
  item?: InventoryItem,
  lookup?: ProductLookupResult
): SubmitBarcodeResult {
  return { ok, message, document, item, lookup };
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePriceAmount(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1000000000) throw new Error('金额必须是 0–1000000000 之间的有效数字。');
  return Math.max(0, Math.round(value * 100) / 100);
}

function nextTopSortIndex(inventory: InventoryFile): number {
  const indexes = Object.values(inventory.items).map((item) => item.sortIndex).filter(Number.isFinite);
  return indexes.length === 0 ? 0 : Math.min(...indexes) - 1;
}

function compareSortIndex(a: InventoryItem, b: InventoryItem): number {
  if (a.sortIndex !== b.sortIndex) {
    return a.sortIndex - b.sortIndex;
  }
  return a.barcode.localeCompare(b.barcode);
}
