import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInventory } from '../shared/inventoryLogic';
import {
  InventoryFile,
  InventoryItem,
  InventoryTransaction,
  LookupStatus,
  SCHEMA_VERSION
} from '../shared/types';

const lookupStatuses: LookupStatus[] = ['idle', 'loading', 'found', 'not_found', 'error'];

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

function migrateInventory(value: unknown, fallbackName: string): InventoryFile {
  if (!isObject(value)) {
    throw new Error('库存文件不是有效的 JSON 对象。');
  }

  const now = new Date().toISOString();
  const rawItems = isObject(value.items) ? value.items : {};
  const items = Object.fromEntries(
    Object.entries(rawItems).map(([barcode, item]) => [barcode, migrateItem(barcode, item, now)])
  );
  const rawTransactions = Array.isArray(value.transactions) ? value.transactions : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryName: asString(value.inventoryName, fallbackName),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now),
    items,
    transactions: rawTransactions.map((transaction, index) => migrateTransaction(transaction, index, now))
  };
}

function migrateItem(barcodeFromKey: string, value: unknown, now: string): InventoryItem {
  const item = isObject(value) ? value : {};
  const barcode = asString(item.barcode, barcodeFromKey);
  const status = asString(item.lookupStatus, 'idle') as LookupStatus;

  return {
    barcode,
    nickname: asString(item.nickname, ''),
    lookupName: asString(item.lookupName, ''),
    brand: asString(item.brand, ''),
    category: asString(item.category, ''),
    imageUrl: asString(item.imageUrl, ''),
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

function asLookupSource(value: unknown): InventoryItem['lookupSource'] {
  return value === 'upcitemdb' || value === 'openfoodfacts' || value === 'web_search' ? value : 'none';
}

function asConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
