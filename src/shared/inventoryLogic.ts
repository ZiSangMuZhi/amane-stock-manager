import {
  InventoryFile,
  InventoryItem,
  InventoryMode,
  ProductLookupResult,
  SCHEMA_VERSION,
  SubmitBarcodeResult
} from './types';

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeBarcode(raw: string): string {
  return raw.replace(/[\r\n\t]/g, '').trim();
}

export function createInventory(inventoryName: string, createdAt = nowIso()): InventoryFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryName,
    createdAt,
    updatedAt: createdAt,
    items: {},
    transactions: []
  };
}

export function createInventoryItem(barcode: string, timestamp = nowIso()): InventoryItem {
  return {
    barcode,
    nickname: '',
    lookupName: '',
    brand: '',
    category: '',
    imageUrl: '',
    priceAmount: null,
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
      Object.entries(inventory.items).map(([barcode, item]) => [barcode, { ...item }])
    ),
    transactions: inventory.transactions.map((transaction) => ({ ...transaction }))
  };
}

export function submitBarcode(
  inventory: InventoryFile,
  rawBarcode: string,
  mode: InventoryMode,
  timestamp = nowIso(),
  idFactory = cryptoRandomId
): { ok: boolean; message: string; inventory: InventoryFile; item?: InventoryItem } {
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode) {
    return { ok: false, message: '条码不能为空。', inventory };
  }

  const existing = inventory.items[barcode];
  if (mode === 'out' && (!existing || existing.quantityOnHand <= 0)) {
    return { ok: false, message: `库存为 0，已阻止出库：${barcode}`, inventory };
  }

  const next = cloneInventory(inventory);
  const item = next.items[barcode] ?? createInventoryItem(barcode, timestamp);

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
  const barcode = normalizeBarcode(rawBarcode);
  const next = cloneInventory(inventory);
  const item = next.items[barcode] ?? createInventoryItem(barcode, timestamp);
  item.nickname = nickname.trim();
  item.updatedAt = timestamp;
  next.items[barcode] = item;
  next.updatedAt = timestamp;
  return next;
}

export function updatePrice(
  inventory: InventoryFile,
  rawBarcode: string,
  priceAmount: number | null,
  priceCurrency: InventoryItem['priceCurrency'],
  timestamp = nowIso()
): InventoryFile {
  const barcode = normalizeBarcode(rawBarcode);
  const next = cloneInventory(inventory);
  const item = next.items[barcode] ?? createInventoryItem(barcode, timestamp);
  item.priceAmount = normalizePriceAmount(priceAmount);
  item.priceCurrency = priceCurrency;
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

export function applyLookupResult(
  inventory: InventoryFile,
  lookup: ProductLookupResult
): InventoryFile {
  const next = cloneInventory(inventory);
  const timestamp = lookup.lookedUpAt;
  const item = next.items[lookup.barcode] ?? createInventoryItem(lookup.barcode, timestamp);

  item.lookupStatus = lookup.status;
  item.lookupUpdatedAt = timestamp;
  if (lookup.status === 'found') {
    item.lookupName = lookup.productName;
    item.brand = lookup.brand;
    item.category = lookup.category;
    item.imageUrl = lookup.imageUrl;
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
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value * 100) / 100);
}
