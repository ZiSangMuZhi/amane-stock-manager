export const SCHEMA_VERSION = 4;

export type InventoryMode = 'in' | 'out';
export type LookupStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error';
export type ExportFormat = 'json' | 'csv-items' | 'csv-transactions' | 'xlsx';
export type ProductLookupSource = 'upcitemdb' | 'openfoodfacts' | 'web_search' | 'none';
export type CurrencyCode = 'CAD' | 'JPY' | 'USD' | 'CNY' | 'EUR' | 'GBP' | 'TWD' | 'HKD';

export interface InventoryItem {
  barcode: string;
  nickname: string;
  lookupName: string;
  brand: string;
  category: string;
  imageUrl: string;
  priceAmount: number | null;
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
  getCurrentInventory(): Promise<InventoryDocument>;
  createInventory(): Promise<InventoryDocument>;
  openInventory(): Promise<InventoryDocument>;
  renameInventory(newName: string): Promise<InventoryDocument>;
  submitBarcode(barcode: string, mode: InventoryMode): Promise<SubmitBarcodeResult>;
  updateNickname(barcode: string, nickname: string): Promise<InventoryDocument>;
  updatePrice(barcode: string, priceAmount: number | null, priceCurrency: CurrencyCode): Promise<InventoryDocument>;
  deleteItem(barcode: string): Promise<InventoryDocument>;
  refreshLookup(barcode: string): Promise<SubmitBarcodeResult>;
  exportInventory(format: ExportFormat): Promise<ExportResult>;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateStatus>;
  onInventoryChanged(callback: (document: InventoryDocument) => void): () => void;
}
