import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { UpdateInfo, UpdateManager, VelopackApp } from 'velopack';
import {
  applyLookupResult,
  createInventory,
  normalizeBarcode,
  shouldLookup,
  submitBarcode,
  toSubmitResult,
  updateNickname
} from '../shared/inventoryLogic';
import { ExportFormat, InventoryDocument, InventoryFile, ProductLookupResult, UpdateStatus } from '../shared/types';
import {
  createInventoryFile,
  normalizeJsonPath,
  readInventoryFile,
  readSettings,
  safeInventoryFileName,
  writeInventoryFile,
  writeSettings
} from './fileStore';
import { defaultExportName, exportInventoryFile } from './exporters';
import { lookupBarcode } from './productLookup';

app.setName('Amane Stock Manager');

VelopackApp.build()
  .onBeforeUninstallFastCallback(() => {
    // User inventory files live outside the install directory; do not remove them during uninstall.
  })
  .run();

const updateUrl = __AMANE_UPDATE_URL__.trim();

let mainWindow: BrowserWindow | null = null;
let currentFilePath: string | null = null;
let currentInventory: InventoryFile | null = null;
let pendingUpdate: UpdateInfo | null = null;
let downloadedUpdate: UpdateInfo | null = null;

function dialogParent(): BrowserWindow {
  if (!mainWindow) {
    throw new Error('Main window is not ready.');
  }
  return mainWindow;
}

function currentDocument(): InventoryDocument {
  return {
    filePath: currentFilePath,
    fileName: currentFilePath ? path.basename(currentFilePath) : '',
    inventory: currentInventory
  };
}

async function saveCurrentInventory(): Promise<void> {
  if (!currentFilePath || !currentInventory) {
    throw new Error('请先新建或打开库存文件。');
  }
  await writeInventoryFile(currentFilePath, currentInventory);
  await writeSettings(app.getPath('userData'), { lastInventoryPath: currentFilePath });
}

function requireInventory(): InventoryFile {
  if (!currentInventory || !currentFilePath) {
    throw new Error('请先新建或打开库存文件。');
  }
  return currentInventory;
}

async function loadLastInventory(): Promise<void> {
  const settings = await readSettings(app.getPath('userData'));
  if (!settings.lastInventoryPath) {
    return;
  }

  try {
    currentInventory = await readInventoryFile(settings.lastInventoryPath);
    currentFilePath = settings.lastInventoryPath;
  } catch {
    currentInventory = null;
    currentFilePath = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 940,
    minHeight: 680,
    title: 'Amane Stock Manager',
    backgroundColor: '#f7f8fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('inventory:get-current', () => currentDocument());

  ipcMain.handle('inventory:create', async () => {
    const result = await dialog.showSaveDialog(dialogParent(), {
      title: '新建库存文件',
      defaultPath: '新库存.json',
      filters: [{ name: 'JSON 库存文件', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) {
      return currentDocument();
    }

    const filePath = normalizeJsonPath(result.filePath);
    const inventoryName = path.basename(filePath, path.extname(filePath));
    currentInventory = await createInventoryFile(filePath, inventoryName);
    currentFilePath = filePath;
    await writeSettings(app.getPath('userData'), { lastInventoryPath: filePath });
    return currentDocument();
  });

  ipcMain.handle('inventory:open', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '打开库存文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON 库存文件', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePaths[0]) {
      return currentDocument();
    }

    currentFilePath = result.filePaths[0];
    currentInventory = await readInventoryFile(currentFilePath);
    await writeSettings(app.getPath('userData'), { lastInventoryPath: currentFilePath });
    return currentDocument();
  });

  ipcMain.handle('inventory:rename', async (_event, rawName: string) => {
    const inventory = requireInventory();
    const safeName = safeInventoryFileName(rawName);
    if (!safeName) {
      throw new Error('库存文件名不能为空。');
    }

    const oldPath = currentFilePath;
    if (!oldPath) {
      throw new Error('当前库存文件没有路径。');
    }

    const newPath = path.join(path.dirname(oldPath), `${safeName}.json`);
    if (path.normalize(newPath).toLowerCase() !== path.normalize(oldPath).toLowerCase()) {
      try {
        await fs.access(newPath);
        throw new Error(`目标文件已存在：${newPath}`);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      await fs.rename(oldPath, newPath);
    }

    currentFilePath = newPath;
    currentInventory = { ...inventory, inventoryName: safeName, updatedAt: new Date().toISOString() };
    await saveCurrentInventory();
    return currentDocument();
  });

  ipcMain.handle('inventory:submit-barcode', async (_event, rawBarcode: string, mode) => {
    const inventory = requireInventory();
    const barcode = normalizeBarcode(rawBarcode);
    const beforeItem = inventory.items[barcode];
    const result = submitBarcode(inventory, barcode, mode);

    if (!result.ok) {
      return toSubmitResult(false, result.message, currentDocument(), result.item);
    }

    currentInventory = result.inventory;
    await saveCurrentInventory();

    let lookup: ProductLookupResult | undefined;
    if (shouldLookup(beforeItem)) {
      lookup = await lookupAndSave(barcode);
    }

    return toSubmitResult(true, lookupMessage(result.message, lookup), currentDocument(), currentInventory?.items[barcode], lookup);
  });

  ipcMain.handle('inventory:update-nickname', async (_event, barcode: string, nickname: string) => {
    const inventory = requireInventory();
    currentInventory = updateNickname(inventory, barcode, nickname);
    await saveCurrentInventory();
    return currentDocument();
  });

  ipcMain.handle('inventory:refresh-lookup', async (_event, rawBarcode: string) => {
    requireInventory();
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) {
      return toSubmitResult(false, '条码不能为空。', currentDocument());
    }

    const lookup = await lookupAndSave(barcode);
    return toSubmitResult(
      lookup.status === 'found',
      lookupMessage('已刷新联网查询。', lookup),
      currentDocument(),
      currentInventory?.items[barcode],
      lookup
    );
  });

  ipcMain.handle('inventory:export', async (_event, format: ExportFormat) => {
    const inventory = requireInventory();
    const result = await dialog.showSaveDialog(dialogParent(), {
      title: '导出库存数据',
      defaultPath: defaultExportName(inventory.inventoryName, format),
      filters: exportFilters(format)
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, message: '已取消导出。' };
    }

    await exportInventoryFile(inventory, format, result.filePath);
    return { ok: true, filePath: result.filePath, message: '导出完成。' };
  });

  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:check-updates', checkForUpdates);
  ipcMain.handle('app:download-update', downloadUpdate);
  ipcMain.handle('app:apply-update', applyUpdate);
  ipcMain.handle('app:open-path', (_event, filePath: string) => shell.showItemInFolder(filePath));
}

async function lookupAndSave(barcode: string): Promise<ProductLookupResult> {
  if (!currentInventory) {
    throw new Error('请先新建或打开库存文件。');
  }

  currentInventory = applyLookupResult(currentInventory, {
    barcode,
    status: 'loading',
    productName: '',
    brand: '',
    category: '',
    imageUrl: '',
    source: 'none',
    confidence: 0,
    lookedUpAt: new Date().toISOString()
  });
  await saveCurrentInventory();

  const lookup = await lookupBarcode(barcode);
  currentInventory = applyLookupResult(currentInventory, lookup);
  await saveCurrentInventory();
  return lookup;
}

function lookupMessage(baseMessage: string, lookup?: ProductLookupResult): string {
  if (!lookup) {
    return baseMessage;
  }
  if (lookup.status === 'found') {
    return `${baseMessage} 已识别：${lookup.productName}（${lookupSourceLabel(lookup.source)}）`;
  }
  if (lookup.status === 'not_found') {
    return `${baseMessage} 未查询到商品名称，可手动编辑昵称。`;
  }
  if (lookup.status === 'error') {
    return `${baseMessage} 联网查询失败，可稍后重试。`;
  }
  return baseMessage;
}

function lookupSourceLabel(source: ProductLookupResult['source']): string {
  if (source === 'upcitemdb') return 'UPCitemdb';
  if (source === 'openfoodfacts') return 'Open Food Facts';
  if (source === 'web_search') return '网页搜索';
  return '无来源';
}

function exportFilters(format: ExportFormat): Electron.FileFilter[] {
  if (format === 'xlsx') {
    return [{ name: 'Excel 工作簿', extensions: ['xlsx'] }];
  }
  if (format === 'json') {
    return [{ name: 'JSON 文件', extensions: ['json'] }];
  }
  return [{ name: 'CSV 文件', extensions: ['csv'] }];
}

async function checkForUpdates(): Promise<UpdateStatus> {
  if (!updateUrl) {
    return {
      state: 'unconfigured',
      currentVersion: app.getVersion(),
      message: '当前构建未配置更新源。'
    };
  }

  try {
    const manager = new UpdateManager(updateUrl);
    const update = await manager.checkForUpdatesAsync();
    pendingUpdate = update;
    downloadedUpdate = null;

    if (!update) {
      return {
        state: 'none',
        currentVersion: safeCurrentVersion(manager),
        message: '已经是最新版本。'
      };
    }

    return {
      state: 'available',
      currentVersion: safeCurrentVersion(manager),
      availableVersion: update.TargetFullRelease?.Version,
      message: `发现新版本 ${update.TargetFullRelease?.Version ?? ''}。`
    };
  } catch (error) {
    return updateErrorStatus(error);
  }
}

async function downloadUpdate(): Promise<UpdateStatus> {
  if (!updateUrl) {
    return {
      state: 'unconfigured',
      currentVersion: app.getVersion(),
      message: '当前构建未配置更新源。'
    };
  }

  try {
    const manager = new UpdateManager(updateUrl);
    if (!pendingUpdate) {
      pendingUpdate = await manager.checkForUpdatesAsync();
    }
    if (!pendingUpdate) {
      return {
        state: 'none',
        currentVersion: safeCurrentVersion(manager),
        message: '没有可下载的更新。'
      };
    }
    await manager.downloadUpdateAsync(pendingUpdate);
    downloadedUpdate = pendingUpdate;
    return {
      state: 'downloaded',
      currentVersion: safeCurrentVersion(manager),
      availableVersion: pendingUpdate.TargetFullRelease?.Version,
      message: '更新已下载，重启后即可安装。'
    };
  } catch (error) {
    return updateErrorStatus(error);
  }
}

async function applyUpdate(): Promise<UpdateStatus> {
  if (!updateUrl) {
    return {
      state: 'unconfigured',
      currentVersion: app.getVersion(),
      message: '当前构建未配置更新源。'
    };
  }

  try {
    const manager = new UpdateManager(updateUrl);
    const update = downloadedUpdate ?? manager.getUpdatePendingRestart() ?? pendingUpdate;
    if (!update) {
      return {
        state: 'none',
        currentVersion: safeCurrentVersion(manager),
        message: '没有等待安装的更新。'
      };
    }

    manager.waitExitThenApplyUpdate(update, false, true);
    app.quit();
    return {
      state: 'downloaded',
      currentVersion: safeCurrentVersion(manager),
      message: '正在退出并安装更新。'
    };
  } catch (error) {
    return updateErrorStatus(error);
  }
}

function safeCurrentVersion(manager: UpdateManager): string {
  try {
    return manager.getCurrentVersion();
  } catch {
    return app.getVersion();
  }
}

function updateErrorStatus(error: unknown): UpdateStatus {
  const message = error instanceof Error ? error.message : String(error);
  const isNotInstalled = /not.?installed|NotInstalled/i.test(message);
  return {
    state: isNotInstalled ? 'not-installed' : 'error',
    currentVersion: app.getVersion(),
    message: isNotInstalled ? '当前应用不是通过 Velopack 安装，更新功能需安装包版本中测试。' : message
  };
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await loadLastInventory();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
