export const SCHEMA_VERSION = 7;

export interface ShopFields {
  imageId: string | null;
  originalCents: number;
  currentCents: number;
  discountBps: number;
  priceSource: 'discount' | 'current';
}

export interface CloudLink { server: string; accountId: string; version: number; baseHash: string }
export interface CloudAccount { id: string; username: string; displayName: string; mustChangePassword: boolean; permissions: string[] }
export interface StockSummary { id: string; name: string; version: number; itemCount: number; quantityOnHand: number; updatedAt: string }
export interface StockRecord { id: string; version: number; inventory: InventoryFile; updatedAt: string }
export interface CloudStatus {
  state: 'local-only' | 'queued' | 'uploading' | 'downloading' | 'synced' | 'offline' | 'error' | 'expired' | 'conflict';
  message: string;
  account: CloudAccount | null;
  secureStorage: boolean;
  connected: boolean;
  pending: boolean;
  lastSuccess: string | null;
  payloadBytes?: number;
}

export type InventoryMode = 'in' | 'out';
export type LookupStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error';
export type ExportFormat = 'json' | 'csv-items' | 'csv-transactions' | 'xlsx';
export type ProductLookupSource = 'upcitemdb' | 'openfoodfacts' | 'web_search' | 'none';
export type CurrencyCode = 'CAD' | 'JPY' | 'USD' | 'CNY' | 'EUR' | 'GBP' | 'TWD' | 'HKD';

export interface InventoryItem {
  listed: boolean;
  shop: ShopFields;
  barcode: string;
  sortIndex: number;
  nickname: string;
  lookupName: string;
  brand: string;
  category: string;
  imageUrl: string;
  priceAmount: number | null;
  salePriceAmount: number | null;
  priceCurrency: CurrencyCode;
  lookupSource: ProductLookupSource;
  lookupConfidence: number;
  quantityOnHand: number;
  totalIn: number;
  totalOut: number;
  firstInAt: string | null;
  lastInAt: string | null;
  lastOutAt: string | null;
  lookupStatus: LookupStatus;
  lookupUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryTransaction {
  id: string;
  barcode: string;
  type: InventoryMode;
  timestamp: string;
  quantityChange: number;
  quantityAfter: number;
  lookupNameAtTime: string;
  nicknameAtTime: string;
}

export interface InventoryFile {
  schemaVersion: typeof SCHEMA_VERSION;
  inventoryId: string;
  cloudLink?: CloudLink;
  inventoryName: string;
  createdAt: string;
  updatedAt: string;
  items: Record<string, InventoryItem>;
  transactions: InventoryTransaction[];
}

export interface InventoryDocument {
  filePath: string | null;
  fileName: string;
  inventory: InventoryFile | null;
}

export interface ProductLookupResult {
  barcode: string;
  status: LookupStatus;
  productName: string;
  brand: string;
  category: string;
  imageUrl: string;
  source: ProductLookupSource;
  confidence: number;
  lookedUpAt: string;
  errorMessage?: string;
}

export interface SubmitBarcodeResult {
  ok: boolean;
  message: string;
  document: InventoryDocument;
  item?: InventoryItem;
  lookup?: ProductLookupResult;
}

export interface ExportResult {
  ok: boolean;
  filePath?: string;
  message: string;
}

export interface UpdateStatus {
  state: 'unconfigured' | 'not-installed' | 'idle' | 'checking' | 'available' | 'none' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  message: string;
}

export interface RendererApi {
  cloudStatus(): Promise<CloudStatus>;
  cloudLogin(username: string, password: string): Promise<CloudStatus>;
  cloudChangePassword(currentPassword: string, newPassword: string): Promise<CloudStatus>;
  cloudLogout(): Promise<CloudStatus>;
  cloudBooks(): Promise<StockSummary[]>;
  cloudConnect(): Promise<CloudStatus>;
  cloudDownload(id: string): Promise<InventoryDocument>;
  cloudRetry(): Promise<CloudStatus>;
  cloudResolve(choice: 'use-cloud' | 'upload-new'): Promise<InventoryDocument>;
  onCloudStatus(callback: (status: CloudStatus) => void): () => void;
  updateListing(barcode: string, listed: boolean): Promise<InventoryDocument>;
  updateShop(barcode: string, shop: ShopFields): Promise<InventoryDocument>;
  chooseShopImage(): Promise<{ dataUrl: string; width: number; height: number } | null>;
  uploadShopImage(barcode: string, dataUrl: string, crop: { x: number; y: number; width: number; height: number }): Promise<InventoryDocument>;
  getShopImage(imageId: string): Promise<string>;
  getCurrentInventory(): Promise<InventoryDocument>;
  createInventory(): Promise<InventoryDocument>;
  openInventory(): Promise<InventoryDocument>;
  renameInventory(newName: string): Promise<InventoryDocument>;
  submitBarcode(barcode: string, mode: InventoryMode): Promise<SubmitBarcodeResult>;
  updateNickname(barcode: string, nickname: string): Promise<InventoryDocument>;
  updatePrice(
    barcode: string,
    purchasePriceAmount: number | null,
    salePriceAmount: number | null,
    priceCurrency: CurrencyCode
  ): Promise<InventoryDocument>;
  updateQuantity(barcode: string, quantityOnHand: number): Promise<InventoryDocument>;
  updateSortOrder(orderedBarcodes: string[]): Promise<InventoryDocument>;
  deleteItem(barcode: string): Promise<InventoryDocument>;
  refreshLookup(barcode: string): Promise<SubmitBarcodeResult>;
  exportInventory(format: ExportFormat): Promise<ExportResult>;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateStatus>;
  onInventoryChanged(callback: (document: InventoryDocument) => void): () => void;
}
