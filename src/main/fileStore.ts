import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalShop, createInventory, emptyShop } from '../shared/inventoryLogic';
import { createHash } from 'node:crypto';
import {
  InventoryFile,
  InventoryItem,
  InventoryTransaction,
  LookupStatus,
  SCHEMA_VERSION
} from '../shared/types';

const lookupStatuses: LookupStatus[] = ['idle', 'loading', 'found', 'not_found', 'error'];
const currencyCodes: InventoryItem['priceCurrency'][] = ['CAD', 'JPY', 'USD', 'CNY', 'EUR', 'GBP', 'TWD', 'HKD'];

export interface StoredSettings {
  lastInventoryPath?: string;
}

export function normalizeJsonPath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.json' ? filePath : `${filePath}.json`;
}

export async function createInventoryFile(filePath: string, inventoryName: string): Promise<InventoryFile> {
  const inventory = createInventory(inventoryName);
  await writeInventoryFile(filePath, inventory);
  return inventory;
}

export async function readInventoryFile(filePath: string): Promise<InventoryFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return migrateInventory(parsed, path.basename(filePath, path.extname(filePath)));
}

export async function writeInventoryFile(filePath: string, inventory: InventoryFile): Promise<void> {
  try {
    const old: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (isObject(old) && (typeof old.schemaVersion !== 'number' || old.schemaVersion < SCHEMA_VERSION)) await backupInventoryFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export async function readSettings(userDataPath: string): Promise<StoredSettings> {
  try {
    const content = await fs.readFile(settingsPath(userDataPath), 'utf-8');
    const parsed = JSON.parse(content) as StoredSettings;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeSettings(userDataPath: string, settings: StoredSettings): Promise<void> {
  const filePath = settingsPath(userDataPath);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function safeInventoryFileName(raw: string): string {
  const trimmed = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ');
  return trimmed || 'inventory';
}

function settingsPath(userDataPath: string): string {
  return path.join(userDataPath, 'settings.json');
}

export function migrateInventory(value: unknown, fallbackName: string): InventoryFile {
  if (!isObject(value)) {
    throw new Error('库存文件不是有效的 JSON 对象。');
  }

  if (typeof value.schemaVersion === 'number' && value.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`此文件使用较新格式 v${value.schemaVersion}，请更新应用。`);
  }
  if (value.schemaVersion !== undefined && (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1)) throw new Error('库存版本无效。');
  if (value.schemaVersion === SCHEMA_VERSION && (typeof value.inventoryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.inventoryId))) throw new Error('此 v7 库存缺少有效的稳定标识。');

  const now = new Date().toISOString();
  const rawItems = isObject(value.items) ? value.items : {};
  const migratedItems = Object.entries(rawItems).map(([barcode, item]) => migrateItem(barcode, item, now, value.schemaVersion === SCHEMA_VERSION));
  const hasStoredSort = migratedItems.some((item) => item.sortIndex !== Number.MAX_SAFE_INTEGER);
  const orderedItems = hasStoredSort
    ? migratedItems.sort(compareItemSort)
    : migratedItems.sort(compareLegacyItemOrder).map((item, index) => ({ ...item, sortIndex: index }));
  const items = Object.fromEntries(orderedItems.map((item) => [item.barcode, item]));
  const rawTransactions = Array.isArray(value.transactions) ? value.transactions : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryId: typeof value.inventoryId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.inventoryId)
      ? value.inventoryId : legacyInventoryId(value),
    ...(isObject(value.cloudLink) && typeof value.cloudLink.server === 'string' && typeof value.cloudLink.accountId === 'string' &&
      typeof value.cloudLink.version === 'number' && typeof value.cloudLink.baseHash === 'string' ? { cloudLink: value.cloudLink as unknown as InventoryFile['cloudLink'] } : {}),
    inventoryName: asString(value.inventoryName, fallbackName),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now),
    items,
    transactions: rawTransactions.map((transaction, index) => migrateTransaction(transaction, index, now))
  };
}

function migrateItem(barcodeFromKey: string, value: unknown, now: string, isV7: boolean): InventoryItem {
  const item = isObject(value) ? value : {};
  const barcode = asString(item.barcode, barcodeFromKey);
  const status = asString(item.lookupStatus, 'idle') as LookupStatus;

  return {
    listed: isV7 && item.listed === true,
    shop: isV7 && isObject(item.shop) ? canonicalShop(item.shop as unknown as InventoryItem['shop']) : {
      ...emptyShop(),
      originalCents: asCurrencyCode(item.priceCurrency) === 'CAD' ? Math.round((asNullableNonNegativeNumber(item.salePriceAmount) ?? 0) * 100) : 0,
      currentCents: asCurrencyCode(item.priceCurrency) === 'CAD' ? Math.round((asNullableNonNegativeNumber(item.salePriceAmount) ?? 0) * 100) : 0
    },
    barcode,
    sortIndex: asSortIndex(item.sortIndex),
    nickname: asString(item.nickname, ''),
    lookupName: asString(item.lookupName, ''),
    brand: asString(item.brand, ''),
    category: asString(item.category, ''),
    imageUrl: asString(item.imageUrl, '').replace(/^http:\/\//i, 'https://'),
    priceAmount: asNullableNonNegativeNumber(item.priceAmount),
    salePriceAmount: asNullableNonNegativeNumber(item.salePriceAmount),
    priceCurrency: asCurrencyCode(item.priceCurrency),
    lookupSource: asLookupSource(item.lookupSource),
    lookupConfidence: asConfidence(item.lookupConfidence),
    quantityOnHand: asNonNegativeInteger(item.quantityOnHand),
    totalIn: asNonNegativeInteger(item.totalIn),
    totalOut: asNonNegativeInteger(item.totalOut),
    firstInAt: asNullableString(item.firstInAt),
    lastInAt: asNullableString(item.lastInAt),
    lastOutAt: asNullableString(item.lastOutAt),
    lookupStatus: lookupStatuses.includes(status) ? status : 'idle',
    lookupUpdatedAt: asNullableString(item.lookupUpdatedAt),
    createdAt: asString(item.createdAt, now),
    updatedAt: asString(item.updatedAt, now)
  };
}

// Pure migration: the same legacy document receives the same identity without changing its source file.
function legacyInventoryId(value: Record<string, unknown>): string {
  const hex = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function backupInventoryFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
  const bytes = await fs.readFile(filePath);
  const tempPath = `${backupPath}.tmp`;
  await fs.writeFile(tempPath, bytes, { flag: 'wx' });
  await fs.rename(tempPath, backupPath);
  return backupPath;
}

function migrateTransaction(value: unknown, index: number, now: string): InventoryTransaction {
  const transaction = isObject(value) ? value : {};
  const type = transaction.type === 'out' ? 'out' : 'in';

  return {
    id: asString(transaction.id, `legacy-${index}`),
    barcode: asString(transaction.barcode, ''),
    type,
    timestamp: asString(transaction.timestamp, now),
    quantityChange: typeof transaction.quantityChange === 'number' ? transaction.quantityChange : type === 'in' ? 1 : -1,
    quantityAfter: asNonNegativeInteger(transaction.quantityAfter),
    lookupNameAtTime: asString(transaction.lookupNameAtTime, ''),
    nicknameAtTime: asString(transaction.nicknameAtTime, '')
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function asSortIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return value;
}

function compareItemSort(a: InventoryItem, b: InventoryItem): number {
  if (a.sortIndex !== b.sortIndex) {
    return a.sortIndex - b.sortIndex;
  }
  return a.barcode.localeCompare(b.barcode);
}

function compareLegacyItemOrder(a: InventoryItem, b: InventoryItem): number {
  const operationDiff = recentOperationTime(b) - recentOperationTime(a);
  if (operationDiff !== 0) {
    return operationDiff;
  }
  if (b.quantityOnHand !== a.quantityOnHand) {
    return b.quantityOnHand - a.quantityOnHand;
  }
  return a.barcode.localeCompare(b.barcode);
}

function recentOperationTime(item: InventoryItem): number {
  return Math.max(Date.parse(item.lastInAt ?? '') || 0, Date.parse(item.lastOutAt ?? '') || 0);
}

function asLookupSource(value: unknown): InventoryItem['lookupSource'] {
  return value === 'upcitemdb' || value === 'openfoodfacts' || value === 'web_search' ? value : 'none';
}

function asConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function asNullableNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value * 100) / 100);
}

function asCurrencyCode(value: unknown): InventoryItem['priceCurrency'] {
  return currencyCodes.includes(value as InventoryItem['priceCurrency']) ? (value as InventoryItem['priceCurrency']) : 'CAD';
}
