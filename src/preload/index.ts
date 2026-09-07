import { contextBridge, ipcRenderer } from 'electron';
import { CurrencyCode, ExportFormat, InventoryDocument, InventoryMode, RendererApi } from '../shared/types';

const api: RendererApi = {
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudLogin: (username, password) => ipcRenderer.invoke('cloud:login', username, password),
  cloudChangePassword: (currentPassword, newPassword) => ipcRenderer.invoke('cloud:password', currentPassword, newPassword),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudBooks: () => ipcRenderer.invoke('cloud:books'),
  cloudConnect: () => ipcRenderer.invoke('cloud:connect'),
  cloudDownload: id => ipcRenderer.invoke('cloud:download', id),
  cloudRetry: () => ipcRenderer.invoke('cloud:retry'),
  cloudResolve: choice => ipcRenderer.invoke('cloud:resolve', choice),
  updateListing: (barcode, listed) => ipcRenderer.invoke('inventory:listing', barcode, listed),
  updateShop: (barcode, shop) => ipcRenderer.invoke('inventory:shop', barcode, shop),
  chooseShopImage: () => ipcRenderer.invoke('cloud:choose-image'),
  uploadShopImage: (barcode, dataUrl, crop) => ipcRenderer.invoke('cloud:upload-image', barcode, dataUrl, crop),
  getShopImage: imageId => ipcRenderer.invoke('cloud:image', imageId),
  onCloudStatus: callback => {
    const listener = (_event: Electron.IpcRendererEvent, status: import('../shared/types').CloudStatus) => callback(status);
    ipcRenderer.on('cloud:status-changed', listener);
    return () => ipcRenderer.removeListener('cloud:status-changed', listener);
  },
  getCurrentInventory: () => ipcRenderer.invoke('inventory:get-current'),
  createInventory: () => ipcRenderer.invoke('inventory:create'),
  openInventory: () => ipcRenderer.invoke('inventory:open'),
  renameInventory: (newName: string) => ipcRenderer.invoke('inventory:rename', newName),
  submitBarcode: (barcode: string, mode: InventoryMode) => ipcRenderer.invoke('inventory:submit-barcode', barcode, mode),
  updateNickname: (barcode: string, nickname: string) => ipcRenderer.invoke('inventory:update-nickname', barcode, nickname),
  updatePrice: (
    barcode: string,
    purchasePriceAmount: number | null,
    salePriceAmount: number | null,
    priceCurrency: CurrencyCode
  ) => ipcRenderer.invoke('inventory:update-price', barcode, purchasePriceAmount, salePriceAmount, priceCurrency),
  updateQuantity: (barcode: string, quantityOnHand: number) =>
    ipcRenderer.invoke('inventory:update-quantity', barcode, quantityOnHand),
  updateSortOrder: (orderedBarcodes: string[]) => ipcRenderer.invoke('inventory:update-sort-order', orderedBarcodes),
  deleteItem: (barcode: string) => ipcRenderer.invoke('inventory:delete-item', barcode),
  refreshLookup: (barcode: string) => ipcRenderer.invoke('inventory:refresh-lookup', barcode),
  exportInventory: (format: ExportFormat) => ipcRenderer.invoke('inventory:export', format),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  applyUpdate: () => ipcRenderer.invoke('app:apply-update'),
  onInventoryChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, document: InventoryDocument) => callback(document);
    ipcRenderer.on('inventory:changed', listener);
    return () => ipcRenderer.removeListener('inventory:changed', listener);
  }
};

contextBridge.exposeInMainWorld('amaneStock', api);
