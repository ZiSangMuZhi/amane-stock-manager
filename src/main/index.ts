import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { UpdateInfo, UpdateManager, VelopackApp } from 'velopack';
import {
  applyLookupResult,
  createInventory,
  deleteInventoryItem,
  normalizeBarcode,
  shouldLookup,
  submitBarcode,
  toSubmitResult,
  updateNickname,
  updatePrice
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
const updateChannel = (__AMANE_UPDATE_CHANNEL__ || 'win').trim() || 'win';
const inventoryFilesFolderName = 'Inventory Files';

let mainWindow: BrowserWindow | null = null;
let currentFilePath: string | null = null;
let currentInventory: InventoryFile | null = null;
let pendingUpdate: UpdateInfo | null = null;
let downloadedUpdate: UpdateInfo | null = null;
let pendingUpdateSource: string | null = null;
let downloadedUpdateSource: string | null = null;
let inventoryWriteQueue: Promise<void> = Promise.resolve();
const lookupTasks = new Set<string>();

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

function queueInventoryWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = inventoryWriteQueue.then(task, task);
  inventoryWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function emitInventoryChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inventory:changed', currentDocument());
  }
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

function isCurrentInventoryPath(filePath: string): boolean {
  return Boolean(
    currentFilePath && path.normalize(currentFilePath).toLowerCase() === path.normalize(filePath).toLowerCase()
  );
}

async function readInventoryForPath(filePath: string): Promise<InventoryFile | null> {
  if (isCurrentInventoryPath(filePath)) {
    return currentInventory;
  }

  try {
    return await readInventoryFile(filePath);
  } catch {
    return null;
  }
}

async function persistInventoryForPath(filePath: string, inventory: InventoryFile): Promise<void> {
  if (isCurrentInventoryPath(filePath)) {
    currentInventory = inventory;
    await writeInventoryFile(filePath, inventory);
    emitInventoryChanged();
    return;
  }

  await writeInventoryFile(filePath, inventory);
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

function getInstallRootDirectory(): string {
  const exeDirectory = app.isPackaged ? path.dirname(process.execPath) : app.getPath('userData');
  return path.basename(exeDirectory).toLowerCase() === 'current' ? path.dirname(exeDirectory) : exeDirectory;
}

async function getInventoryFilesDirectory(): Promise<string> {
  const directory = path.join(getInstallRootDirectory(), inventoryFilesFolderName);
  await fs.mkdir(directory, { recursive: true });
  return directory;
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
    const inventoryDirectory = await getInventoryFilesDirectory();
    const result = await dialog.showSaveDialog(dialogParent(), {
      title: '新建库存文件',
      defaultPath: path.join(inventoryDirectory, '新库存.json'),
      filters: [{ name: 'JSON 库存文件', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) {
      return currentDocument();
    }

    const filePath = normalizeJsonPath(result.filePath);
    return queueInventoryWrite(async () => {
      const inventoryName = path.basename(filePath, path.extname(filePath));
      currentInventory = await createInventoryFile(filePath, inventoryName);
      currentFilePath = filePath;
      await writeSettings(app.getPath('userData'), { lastInventoryPath: filePath });
      return currentDocument();
    });
  });

  ipcMain.handle('inventory:open', async () => {
    const inventoryDirectory = await getInventoryFilesDirectory();
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: '打开库存文件',
      defaultPath: inventoryDirectory,
      properties: ['openFile'],
      filters: [{ name: 'JSON 库存文件', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePaths[0]) {
      return currentDocument();
    }

    const filePath = result.filePaths[0];
    return queueInventoryWrite(async () => {
      currentFilePath = filePath;
      currentInventory = await readInventoryFile(currentFilePath);
      await writeSettings(app.getPath('userData'), { lastInventoryPath: currentFilePath });
      return currentDocument();
    });
  });

  ipcMain.handle('inventory:rename', async (_event, rawName: string) => {
    return queueInventoryWrite(async () => {
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
  });

  ipcMain.handle('inventory:submit-barcode', async (_event, rawBarcode: string, mode) => {
    const response = await queueInventoryWrite(async () => {
      const inventory = requireInventory();
      const barcode = normalizeBarcode(rawBarcode);
      const beforeItem = inventory.items[barcode];
      const result = submitBarcode(inventory, barcode, mode);

      if (!result.ok) {
        return {
          submitResult: toSubmitResult(false, result.message, currentDocument(), result.item),
          lookupFilePath: null,
          lookupBarcode: '',
          shouldStartLookup: false
        };
      }

      const shouldStartLookup = shouldLookup(beforeItem);
      currentInventory = shouldStartLookup
        ? applyLookupResult(result.inventory, loadingLookupResult(barcode))
        : result.inventory;
      await saveCurrentInventory();

      return {
        submitResult: toSubmitResult(
          true,
          shouldStartLookup ? `${result.message}，正在后台查询商品名称。` : result.message,
          currentDocument(),
          currentInventory?.items[barcode]
        ),
        lookupFilePath: currentFilePath,
        lookupBarcode: barcode,
        shouldStartLookup
      };
    });

    if (response.shouldStartLookup && response.lookupFilePath) {
      startLookupForFile(response.lookupBarcode, response.lookupFilePath);
    }

    return response.submitResult;
  });

  ipcMain.handle('inventory:update-nickname', async (_event, barcode: string, nickname: string) => {
    return queueInventoryWrite(async () => {
      const inventory = requireInventory();
      currentInventory = updateNickname(inventory, barcode, nickname);
      await saveCurrentInventory();
      return currentDocument();
    });
  });

  ipcMain.handle('inventory:update-price', async (_event, barcode: string, priceAmount: number | null, priceCurrency) => {
    return queueInventoryWrite(async () => {
      const inventory = requireInventory();
      currentInventory = updatePrice(inventory, barcode, priceAmount, priceCurrency);
      await saveCurrentInventory();
      return currentDocument();
    });
  });

  ipcMain.handle('inventory:delete-item', async (_event, barcode: string) => {
    return queueInventoryWrite(async () => {
      const inventory = requireInventory();
      currentInventory = deleteInventoryItem(inventory, barcode);
      await saveCurrentInventory();
      return currentDocument();
    });
  });

  ipcMain.handle('inventory:refresh-lookup', async (_event, rawBarcode: string) => {
    const response = await queueInventoryWrite(async () => {
      const inventory = requireInventory();
      const barcode = normalizeBarcode(rawBarcode);
      if (!barcode) {
        return {
          submitResult: toSubmitResult(false, '条码不能为空。', currentDocument()),
          lookupFilePath: null,
          lookupBarcode: '',
          shouldStartLookup: false
        };
      }
      if (!inventory.items[barcode]) {
        return {
          submitResult: toSubmitResult(false, `当前库存文件中没有该条码：${barcode}`, currentDocument()),
          lookupFilePath: null,
          lookupBarcode: barcode,
          shouldStartLookup: false
        };
      }

      const alreadyRunning = currentFilePath ? isLookupRunning(barcode, currentFilePath) : false;
      if (!alreadyRunning) {
        currentInventory = applyLookupResult(inventory, loadingLookupResult(barcode));
        await saveCurrentInventory();
      }

      return {
        submitResult: toSubmitResult(
          true,
          alreadyRunning ? '该条码已有后台查询任务。' : '已开始后台刷新商品名称。',
          currentDocument(),
          currentInventory?.items[barcode]
        ),
        lookupFilePath: currentFilePath,
        lookupBarcode: barcode,
        shouldStartLookup: !alreadyRunning
      };
    });

    if (response.shouldStartLookup && response.lookupFilePath) {
      startLookupForFile(response.lookupBarcode, response.lookupFilePath);
    }

    return response.submitResult;
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

function loadingLookupResult(barcode: string): ProductLookupResult {
  return {
    barcode,
    status: 'loading',
    productName: '',
    brand: '',
    category: '',
    imageUrl: '',
    source: 'none',
    confidence: 0,
    lookedUpAt: new Date().toISOString()
  };
}

function errorLookupResult(barcode: string, error: unknown): ProductLookupResult {
  return {
    barcode,
    status: 'error',
    productName: '',
    brand: '',
    category: '',
    imageUrl: '',
    source: 'none',
    confidence: 0,
    lookedUpAt: new Date().toISOString(),
    errorMessage: error instanceof Error ? error.message : String(error)
  };
}

function lookupTaskKey(barcode: string, filePath: string): string {
  return `${path.normalize(filePath).toLowerCase()}\0${barcode}`;
}

function isLookupRunning(barcode: string, filePath: string): boolean {
  return lookupTasks.has(lookupTaskKey(barcode, filePath));
}

function startLookupForFile(barcode: string, filePath: string): boolean {
  const key = lookupTaskKey(barcode, filePath);
  if (lookupTasks.has(key)) {
    return false;
  }

  lookupTasks.add(key);
  void runLookupForFile(barcode, filePath)
    .catch((error) => {
      console.error('Background barcode lookup failed:', error);
    })
    .finally(() => {
      lookupTasks.delete(key);
    });
  return true;
}

async function runLookupForFile(barcode: string, filePath: string): Promise<void> {
  let lookup: ProductLookupResult;
  try {
    lookup = await lookupBarcode(barcode);
  } catch (error) {
    lookup = errorLookupResult(barcode, error);
  }

  await queueInventoryWrite(async () => {
    const inventory = await readInventoryForPath(filePath);
    if (!inventory?.items[barcode]) {
      return;
    }

    const next = applyLookupResult(inventory, lookup);
    await persistInventoryForPath(filePath, next);
  });
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
    const source = await prepareUpdateSource();
    const manager = createUpdateManager(source);
    const update = await manager.checkForUpdatesAsync();
    pendingUpdate = update;
    pendingUpdateSource = update ? source : null;
    downloadedUpdate = null;
    downloadedUpdateSource = null;

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
    const source = pendingUpdateSource ?? (await prepareUpdateSource());
    const manager = createUpdateManager(source);
    if (!pendingUpdate) {
      pendingUpdate = await manager.checkForUpdatesAsync();
      pendingUpdateSource = pendingUpdate ? source : null;
    }
    if (!pendingUpdate) {
      return {
        state: 'none',
        currentVersion: safeCurrentVersion(manager),
        message: '没有可下载的更新。'
      };
    }
    await ensureUpdatePackageAvailable(pendingUpdate, pendingUpdateSource ?? source);
    await manager.downloadUpdateAsync(pendingUpdate);
    downloadedUpdate = pendingUpdate;
    downloadedUpdateSource = pendingUpdateSource ?? source;
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
    const manager = createUpdateManager(downloadedUpdateSource ?? pendingUpdateSource ?? updateUrl);
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

function createUpdateManager(source: string = updateUrl): UpdateManager {
  return new UpdateManager(source, {
    AllowVersionDowngrade: false,
    ExplicitChannel: updateChannel,
    MaximumDeltasBeforeFallback: -1
  });
}

async function prepareUpdateSource(): Promise<string> {
  if (!shouldUseGitHubCacheSource()) {
    return updateUrl;
  }

  const directory = await getUpdateCacheDirectory();
  await downloadUpdateAsset(`releases.${updateChannel}.json`, path.join(directory, `releases.${updateChannel}.json`));
  return directory;
}

async function ensureUpdatePackageAvailable(update: UpdateInfo, source: string): Promise<void> {
  if (!isGitHubCacheDirectory(source)) {
    return;
  }

  await downloadUpdateAsset(update.TargetFullRelease.FileName, path.join(source, update.TargetFullRelease.FileName), {
    expectedSize: update.TargetFullRelease.Size
  });
}

function shouldUseGitHubCacheSource(): boolean {
  try {
    const url = new URL(updateUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      /\/releases\/latest\/download\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function getUpdateCacheDirectory(): Promise<string> {
  const directory = path.join(app.getPath('userData'), 'update-cache', updateChannel);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function isGitHubCacheDirectory(source: string): boolean {
  const cacheRoot = path.resolve(app.getPath('userData'), 'update-cache').toLowerCase();
  const sourcePath = path.resolve(source).toLowerCase();
  return sourcePath === cacheRoot || sourcePath.startsWith(`${cacheRoot}${path.sep}`);
}

async function downloadUpdateAsset(
  fileName: string,
  destinationPath: string,
  options: { expectedSize?: number } = {}
): Promise<void> {
  const safeFileName = path.basename(fileName);
  if (safeFileName !== fileName) {
    throw new Error(`更新资产文件名不安全：${fileName}`);
  }

  if (options.expectedSize && (await hasExpectedFileSize(destinationPath, options.expectedSize))) {
    return;
  }

  const assetUrl = new URL(safeFileName, updateUrl).toString();
  const response = await fetch(assetUrl, {
    headers: {
      'User-Agent': 'AmaneStockManager/0.1.9'
    }
  });
  if (!response.ok) {
    throw new Error(`无法下载更新资产 ${safeFileName}：HTTP ${response.status}`);
  }

  const temporaryPath = `${destinationPath}.download`;
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(temporaryPath, bytes);
  if (options.expectedSize && bytes.length !== options.expectedSize) {
    await fs.rm(temporaryPath, { force: true });
    throw new Error(`更新资产大小不匹配：${safeFileName}`);
  }
  await fs.rename(temporaryPath, destinationPath);
}

async function hasExpectedFileSize(filePath: string, expectedSize: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size === expectedSize;
  } catch {
    return false;
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
  const sourceDetails = `更新源：${updateUrl || '未配置'}；通道：${updateChannel}`;
  return {
    state: isNotInstalled ? 'not-installed' : 'error',
    currentVersion: app.getVersion(),
    message: isNotInstalled
      ? `当前应用不是通过 Velopack 安装，更新功能需安装包版本中测试。${sourceDetails}`
      : `${message}（${sourceDetails}）`
  };
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await getInventoryFilesDirectory();
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
