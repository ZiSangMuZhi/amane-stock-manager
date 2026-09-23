import { CloudAccount, StockRecord, StockSummary } from '../shared/types';
import { CloudError } from './cloudSync';
import { TokenVault } from './cloudStore';
import { migrateInventory } from './fileStore';
import type { ShopProduct } from './shopPriceSync';

// Deployment host is a build-time constant, never a renderer argument or an imported file setting.
export const ADMIN_ORIGIN = 'https://api.amaneacg.space';
export const ADMIN_SESSION_FILE = 'admin-session-api.amaneacg.space.encrypted';
const SESSION_COOKIE = '__Host-amane_admin_session';
const CSRF_COOKIE = '__Host-amane_admin_csrf';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;
const PRODUCT_FIELDS = ['name', 'imageId', 'currency', 'originalCents', 'currentCents', 'discountBps', 'priceSource'];

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function productContent(value: unknown, allowCategory: boolean): boolean {
  if (!object(value) || Object.keys(value).some(key => !PRODUCT_FIELDS.includes(key) && !(allowCategory && key === 'categoryId')) ||
      typeof value.name !== 'string' || value.name !== value.name.trim() || !value.name.length || value.name.length > 100 ||
      !(value.imageId === null || uuid(value.imageId)) || value.currency !== 'CAD' ||
      !integer(value.originalCents, 0, 100_000_000) || !integer(value.currentCents, 0, 100_000_000) ||
      !integer(value.discountBps, 0, 10_000) || (value.priceSource !== 'discount' && value.priceSource !== 'current') ||
      (value.categoryId !== undefined && value.categoryId !== null && !uuid(value.categoryId))) return false;
  if (!value.originalCents) return value.currentCents === 0 && value.discountBps === 0;
  if (value.currentCents > value.originalCents) return false;
  return value.priceSource === 'discount'
    ? value.currentCents === Math.round(value.originalCents * (10_000 - value.discountBps) / 10_000)
    : value.discountBps === Math.round((value.originalCents - value.currentCents) * 10_000 / value.originalCents);
}
function checkedProduct(value: unknown, expectedId?: string): ShopProduct {
  if (!object(value) || !uuid(value.id) || (expectedId !== undefined && value.id !== expectedId) || !integer(value.version, 1) ||
      !(value.sourceBookId === null || uuid(value.sourceBookId)) ||
      !(value.sourceBarcode === null || (typeof value.sourceBarcode === 'string' && value.sourceBarcode === value.sourceBarcode.trim() &&
        value.sourceBarcode.length > 0 && value.sourceBarcode.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.sourceBarcode) &&
        !['__proto__', 'constructor', 'prototype'].includes(value.sourceBarcode))) ||
      (value.sourceBookId === null) !== (value.sourceBarcode === null) || typeof value.shopRegistered !== 'boolean' ||
      !(value.deletedAt === null || (typeof value.deletedAt === 'string' && value.deletedAt.length <= 40 && Number.isFinite(Date.parse(value.deletedAt)))) ||
      (value.listed !== undefined && typeof value.listed !== 'boolean') || (value.stock !== undefined && !integer(value.stock, 0, 1_000_000_000)) ||
      !productContent(value.content, true)) throw new CloudError('云端商品响应无效。', 502);
  return value as unknown as ShopProduct;
}

function allowedRoute(method: string, route: string): boolean {
  if (method === 'GET' && ['/api/auth/session', '/api/stock-books', '/api/products'].includes(route)) return true;
  if (method === 'POST' && ['/api/auth/login', '/api/auth/logout', '/api/auth/change-password', '/api/stock-books', '/api/products/media'].includes(route)) return true;
  const match = /^\/api\/(stock-books|products|products\/media)\/([^/]+)$/.exec(route);
  return !!match && uuid(match[2]) && (method === 'GET' || (method === 'PUT' && match[1] !== 'products/media'));
}

export function checkedId(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new CloudError('无效的云端库存或图片标识。', 400);
  return id;
}

export class CloudClient {
  account: CloudAccount | null = null;
  private cookies = new Map<string, string>();
  constructor(private readonly vault: TokenVault, private readonly transport: typeof fetch = fetch) {}
  get secureStorage(): boolean { return this.vault.available; }
  async restore(): Promise<void> {
    this.cookies.clear(); this.account = null;
    const value = await this.vault.load();
    if (value) {
      try {
        const saved: unknown = JSON.parse(value);
        if (!object(saved) || saved.origin !== ADMIN_ORIGIN || !object(saved.cookies) ||
            typeof saved.cookies[SESSION_COOKIE] !== 'string' || !COOKIE_VALUE.test(saved.cookies[SESSION_COOKIE])) throw new Error('Session origin mismatch');
        for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
          const cookie = saved.cookies[name];
          if (cookie !== undefined) {
            if (typeof cookie !== 'string' || !COOKIE_VALUE.test(cookie)) throw new Error('Invalid saved cookie');
            this.cookies.set(name, cookie);
          }
        }
      } catch { await this.clear(); return; }
    }
    if (this.cookies.size) await this.session();
  }
  private async clear(): Promise<void> { this.cookies.clear(); this.account = null; await this.vault.clear(); }
  private adoptAccount(payload: { authenticated?: boolean; account?: CloudAccount }): CloudAccount | null {
    if (payload.account && typeof payload.account.id === 'string' && Array.isArray(payload.account.permissions)) {
      const a = payload.account;
      this.account = { id: a.id, username: String(a.username ?? ''), displayName: String(a.displayName ?? a.username ?? ''), mustChangePassword: a.mustChangePassword === true, permissions: a.permissions.filter(p => typeof p === 'string') };
    } else this.account = null;
    return this.account;
  }
  async login(username: string, password: string): Promise<void> {
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 200 || password.length > 1024) throw new CloudError('登录信息无效。', 400);
    await this.clear();
    const result = await this.request<{ account: CloudAccount }>('POST', '/api/auth/login', JSON.stringify({ username, password }));
    this.adoptAccount(result);
  }
  async session(): Promise<void> { this.adoptAccount(await this.request('GET', '/api/auth/session')); }
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length > 1024 || currentPassword.length > 1024) throw new CloudError('密码格式无效。', 400);
    this.adoptAccount(await this.request('POST', '/api/auth/change-password', JSON.stringify({ currentPassword, newPassword })));
  }
  async logout(): Promise<void> {
    try { if (this.account) await this.request('POST', '/api/auth/logout', '{}'); }
    finally { await this.clear(); }
  }
  private authenticatedAccount(): CloudAccount {
    if (!this.account) throw new CloudError('请登录管理员账号。', 401);
    if (this.account.mustChangePassword) throw new CloudError('请先修改首次登录密码。', 428);
    return this.account;
  }
  requireAccount(): CloudAccount {
    const account = this.authenticatedAccount();
    if (!account.permissions.includes('content.manage')) throw new CloudError('此账号没有库存管理权限。', 403);
    return account;
  }
  private requireProductAccount(write = false): void {
    const account = this.authenticatedAccount();
    if (!account.permissions.includes('products.manage') || (write && !account.permissions.includes('pricing.manage'))) {
      throw new CloudError(write ? '此账号没有商店商品及价格管理权限。' : '此账号没有商店商品管理权限。', 403);
    }
  }
  async products(): Promise<ShopProduct[]> {
    this.requireProductAccount();
    const payload = await this.productRequest('GET', '/api/products');
    if (!object(payload) || !Array.isArray(payload.items)) throw new CloudError('云端商品列表响应无效。', 502);
    const items = payload.items.map(value => checkedProduct(value));
    if (new Set(items.map(item => item.id)).size !== items.length) throw new CloudError('云端商品列表包含重复标识。', 502);
    return items;
  }
  async product(id: string): Promise<ShopProduct> {
    this.requireProductAccount();
    return checkedProduct(await this.productRequest('GET', `/api/products/${checkedId(id)}`), id);
  }
  async saveProductPrice(id: string, body: string): Promise<ShopProduct> {
    this.requireProductAccount(true); checkedId(id);
    if (typeof body !== 'string' || Buffer.byteLength(body) > 16 * 1024) throw new CloudError('商品价格请求无效或超过大小限制。', 400, true);
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new CloudError('商品价格请求无效。', 400, true); }
    if (!object(value) || Object.keys(value).some(key => !['version', 'requestKey', 'content'].includes(key)) ||
        !integer(value.version, 1) || !uuid(value.requestKey) || !productContent(value.content, false)) throw new CloudError('商品价格请求无效。', 400, true);
    // The sync journal owns these exact bytes and the idempotency key. Never rewrite or retry them here.
    return checkedProduct(await this.productRequest('PUT', `/api/products/${id}`, body), id);
  }
  private async productRequest(method: 'GET' | 'PUT', route: string, body?: string): Promise<unknown> {
    const response = await this.fetchResponse(method, route, body);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new CloudError('云端商品响应无效。', 502);
    const bytes = await this.readBytes(response, 20 * 1024 * 1024);
    try { return JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw new CloudError('云端商品响应无效。', 502); }
  }
  async books(): Promise<StockSummary[]> { this.requireAccount(); return (await this.request<{ items: StockSummary[] }>('GET', '/api/stock-books')).items; }
  async stock(method: 'GET' | 'POST' | 'PUT', id: string, body?: string): Promise<StockRecord> {
    this.requireAccount(); checkedId(id);
    const record = await this.request<StockRecord>(method, `/api/stock-books${method === 'POST' ? '' : `/${id}`}`, body);
    if (record.inventory?.schemaVersion !== 7 || record.id !== id || record.inventory.inventoryId !== id) throw new CloudError('云端库存响应无效。', 502);
    record.inventory = migrateInventory(record.inventory, '云端库存');
    return record;
  }
  async uploadImage(dataUrl: string, crop: { x: number; y: number; width: number; height: number }): Promise<string> {
    this.requireAccount();
    if (typeof dataUrl !== 'string' || dataUrl.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      !crop || !Object.values(crop).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ||
      crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.00001 || crop.y + crop.height > 1.00001) throw new CloudError('请选择有效图片及裁切范围。', 400);
    const image = await this.request<{id: string}>('POST', '/api/products/media', JSON.stringify({ base64: dataUrl.split(',')[1], crop }));
    return checkedId(image.id);
  }
  async image(id: string): Promise<string> {
    this.requireAccount();
    const response = await this.fetchResponse('GET', `/api/products/media/${checkedId(id)}`);
    if (!/^image\/(webp|png|jpeg)(;|$)/i.test(response.headers.get('content-type') ?? '')) throw new CloudError('图片响应无效。', 502);
    const bytes = await this.readBytes(response, 8 * 1024 * 1024);
    return `data:${response.headers.get('content-type')!.split(';')[0]};base64,${bytes.toString('base64')}`;
  }
  private async readBytes(response: Response, max: number): Promise<Buffer> {
    if (Number(response.headers.get('content-length') ?? 0) > max) throw new CloudError('云端响应超过大小限制。', 413);
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
      if (length > max) { await reader.cancel(); throw new CloudError('云端响应超过大小限制。', 413); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  }
  private async fetchResponse(method: string, route: string, body?: string): Promise<Response> {
    if (!allowedRoute(method, route)) throw new CloudError('请求路径无效。', 400);
    const headers: Record<string, string> = { Accept: 'application/json', Origin: ADMIN_ORIGIN };
    if (body) { if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new CloudError('库存超过 16 MiB 同步限制。', 413, true); headers['Content-Type'] = 'application/json'; }
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; ');
    if (this.cookies.has(CSRF_COOKIE)) headers['X-CSRF-Token'] = this.cookies.get(CSRF_COOKIE)!;
    const response = await this.transport(`${ADMIN_ORIGIN}${route}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== ADMIN_ORIGIN)) {
      throw new CloudError('云端响应来源无效，已拒绝跳转。', 502);
    }
    // Only accept our two host cookies. Tokens never enter renderer or inventory JSON.
    let changed = false;
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^([^=;]+)=([^;]*)/.exec(cookie);
      if (!match || ![SESSION_COOKIE, CSRF_COOKIE].includes(match[1]!)) continue;
      const attributes = cookie.split(';').slice(1).map(part => part.trim());
      if (!attributes.some(part => /^secure$/i.test(part)) || !attributes.some(part => /^path=\/$/i.test(part)) ||
          attributes.some(part => /^domain(?:=|$)/i.test(part)) || attributes.filter(part => /^path=/i.test(part)).length !== 1) continue;
      const [name, value] = [match[1]!, match[2]!];
      if (value && !COOKIE_VALUE.test(value)) continue;
      if (value && !/max-age=0(?:;|$)/i.test(cookie)) this.cookies.set(name, value); else this.cookies.delete(name);
      changed = true;
    }
    if (changed) await this.vault.save(JSON.stringify({ origin: ADMIN_ORIGIN, cookies: Object.fromEntries(this.cookies) }));
    if (!response.ok) {
      if (response.status === 401) { this.account = null; }
      let inventoryMissing = false;
      if ([404, 410].includes(response.status) && /^\/api\/stock-books(?:\/[0-9a-f-]+)?$/i.test(route) &&
          /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        // Only the stock API's explicit absence response can recreate a book.
        // A proxy/router 404, permission failure, or unreadable response must keep the old binding.
        try { inventoryMissing = JSON.parse((await this.readBytes(response, 16 * 1024)).toString('utf8')).error === 'STOCK_REQUEST_FAILED'; }
        catch { /* Keep the original HTTP failure without changing local identity. */ }
      }
      const errors: Record<number, string> = { 401: '登录已失效或用户名密码错误，请重新登录。', 403: '当前账号没有权限，或会话安全校验已失效。', 409: '云端已更新，请选择冲突处理方式。', 428: '请先更新首次登录密码。' };
      throw new CloudError(inventoryMissing ? '云端库存已删除或不存在，本地内容已保留。' : errors[response.status] ?? `服务器拒绝请求（HTTP ${response.status}），本地内容已保留。`, response.status, [400, 413].includes(response.status), inventoryMissing);
    }
    return response;
  }
  private async request<T>(method: string, route: string, body?: string): Promise<T> {
    const response = await this.fetchResponse(method, route, body);
    return JSON.parse((await this.readBytes(response, 20 * 1024 * 1024)).toString('utf8')) as T;
  }
}
