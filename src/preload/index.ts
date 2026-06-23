import { contextBridge, ipcRenderer } from 'electron';
import { CurrencyCode, ExportFormat, InventoryMode, RendererApi } from '../shared/types';

const api: RendererApi = {
  getCurrentInventory: () => ipcRenderer.invoke('inventory:get-current'),
  createInventory: () => ipcRenderer.invoke('inventory:create'),
  openInventory: () => ipcRenderer.invoke('inventory:open'),
  renameInventory: (newName: string) => ipcRenderer.invoke('inventory:rename', newName),
  submitBarcode: (barcode: string, mode: InventoryMode) => ipcRenderer.invoke('inventory:submit-barcode', barcode, mode),
  updateNickname: (barcode: string, nickname: string) => ipcRenderer.invoke('inventory:update-nickname', barcode, nickname),
  updatePrice: (barcode: string, priceAmount: number | null, priceCurrency: CurrencyCode) =>
    ipcRenderer.invoke('inventory:update-price', barcode, priceAmount, priceCurrency),
  deleteItem: (barcode: string) => ipcRenderer.invoke('inventory:delete-item', barcode),
  refreshLookup: (barcode: string) => ipcRenderer.invoke('inventory:refresh-lookup', barcode),
  exportInventory: (format: ExportFormat) => ipcRenderer.invoke('inventory:export', format),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  applyUpdate: () => ipcRenderer.invoke('app:apply-update')
};

contextBridge.exposeInMainWorld('amaneStock', api);
