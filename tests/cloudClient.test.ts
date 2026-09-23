import { describe, expect, it, vi } from 'vitest';
import { ADMIN_ORIGIN, ADMIN_SESSION_FILE, CloudClient } from '../src/main/cloudClient';
import type { TokenVault } from '../src/main/cloudStore';
import type { ShopProduct } from '../src/main/shopPriceSync';

const id = 'a71c05f0-9c2f-4a5f-ae9f-b5298d5c0602';
const sourceBookId = 'c6ab6f95-3504-4de1-89bf-2b2c4126709f';
const requestKey = '89535f1d-7780-4cc5-9f89-c169da5d9048';
const cookies = { '__Host-amane_admin_session': 'synthetic-session', '__Host-amane_admin_csrf': 'synthetic-csrf' };
const account = { id: 'synthetic-admin', username: 'synthetic', displayName: 'Synthetic', mustChangePassword: false, permissions: ['content.manage', 'products.manage', 'pricing.manage'] };
const content = { name: '保留商店名称', imageId: null, currency: 'CAD' as const, originalCents: 1000, currentCents: 800, discountBps: 2000, priceSource: 'current' as const };
const product: ShopProduct = { id, version: 3, sourceBookId, sourceBarcode: '001234', shopRegistered: true, deletedAt: null, content, listed: true, stock: 2 };
const body = JSON.stringify({ requestKey, content, version: 3 }, null, 2) + '\n';
const response = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } });
function fixture(transport: typeof fetch = async url => response(String(url).endsWith('/api/products') ? { items: [product] } : product), saved: unknown = null) {
  const vault = { available: true, load: vi.fn(async () => saved === null ? null : typeof saved === 'string' ? saved : JSON.stringify(saved)), save: vi.fn(async (_value: string) => undefined), clear: vi.fn(async () => undefined) };
  const requests: { url: string; options: RequestInit }[] = [];
  const client = new CloudClient(vault as unknown as TokenVault, async (url, options = {}) => { requests.push({ url: String(url), options }); return transport(url, options); });
  client.account = structuredClone(account);
  return { client, vault, requests };
}

describe('API host and persisted session isolation', () => {
  it('pins the production API host and a separate encrypted session filename', () => {
    expect(ADMIN_ORIGIN).toBe('https://api.amaneacg.space');
    expect(ADMIN_SESSION_FILE).toBe('admin-session-api.amaneacg.space.encrypted');
  });
  it.each([
    cookies,
    { origin: 'https://amane-admin-mtjbdhzwkq-uc.a.run.app', cookies },
    { origin: 'https://api.amaneacg.space.evil.invalid', cookies },
    { origin: 'http://api.amaneacg.space', cookies },
    { origin: `${ADMIN_ORIGIN}/`, cookies },
    { origin: ADMIN_ORIGIN, cookies: { ...cookies, '__Host-amane_admin_csrf': 'bad;value' } },
    { origin: ADMIN_ORIGIN, cookies: { '__Host-amane_admin_csrf': 'csrf-only' } },
    { origin: ADMIN_ORIGIN, cookies: [] },
    '{broken',
  ])('does not send legacy, foreign-host or malformed credentials %#', async saved => {
    const { client, vault, requests } = fixture(undefined, saved);
    await client.restore();
    expect(client.account).toBeNull(); expect(requests).toHaveLength(0); expect(vault.clear).toHaveBeenCalledOnce();
  });
  it('restores only the pinned envelope and obtains the current server account', async () => {
    const { client, requests } = fixture(async () => response({ account: { ...account, id: 'current-server-account' } }), { origin: ADMIN_ORIGIN, cookies });
    client.account = null; await client.restore();
    expect(client.account).toMatchObject({ id: 'current-server-account' });
    expect(requests[0]?.url).toBe(`${ADMIN_ORIGIN}/api/auth/session`);
    expect(requests[0]?.options.headers).toMatchObject({ Cookie: '__Host-amane_admin_session=synthetic-session; __Host-amane_admin_csrf=synthetic-csrf', Origin: ADMIN_ORIGIN, 'X-CSRF-Token': 'synthetic-csrf' });
  });
  it('persists only the host-bound cookie envelope after login', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', '__Host-amane_admin_session=synthetic-session; Secure; HttpOnly; Path=/');
    headers.append('set-cookie', '__Host-amane_admin_csrf=synthetic-csrf; Secure; Path=/');
    headers.append('set-cookie', 'unrelated=ignored; Secure; Path=/');
    const { client, vault } = fixture(async () => new Response(JSON.stringify({ account }), { headers }));
    await client.login('synthetic', 'never-persist-password');
    expect(vault.save).toHaveBeenCalledOnce();
    const saved = vault.save.mock.calls[0]![0];
    expect(JSON.parse(saved)).toEqual({ origin: ADMIN_ORIGIN, cookies });
    expect(saved).not.toContain('never-persist-password'); expect(JSON.stringify(client.account)).not.toContain('synthetic-session');
  });
  it.each([
    '__Host-amane_admin_session=unsafe; Path=/',
    '__Host-amane_admin_session=unsafe; Secure',
    '__Host-amane_admin_session=unsafe; Secure; Path=/api',
    '__Host-amane_admin_session=unsafe; Secure; Path=/; Domain=api.amaneacg.space',
    '__Host-amane_admin_session=unsafe; Secure; Path=/; Domain=evil.invalid',
    '__Host-amane_admin_session=unsafe; Secure; Path=/; Path=/api',
    '__Host-amane_admin_session=bad value; Secure; Path=/',
  ])('rejects Set-Cookie that does not have exact host-cookie scope: %s', async cookie => {
    const { client, vault, requests } = fixture(async url => String(url).endsWith('/login')
      ? response({ account }, 200, { 'set-cookie': cookie }) : response({ items: [] }));
    await client.login('synthetic', 'password'); await client.products();
    expect(vault.save).not.toHaveBeenCalled(); expect(requests[1]?.options.headers).not.toHaveProperty('Cookie');
  });
  it('removes a properly scoped expired session cookie', async () => {
    const { client, vault, requests } = fixture(async url => String(url).endsWith('/session')
      ? response({ account }, 200, { 'set-cookie': '__Host-amane_admin_session=; Max-Age=0; Secure; Path=/' }) : response({ items: [] }), { origin: ADMIN_ORIGIN, cookies });
    await client.restore(); await client.products();
    expect(JSON.parse(vault.save.mock.calls[0]![0]).cookies).not.toHaveProperty('__Host-amane_admin_session');
    expect((requests[1]!.options.headers as Record<string, string>).Cookie).not.toContain('amane_admin_session');
  });
});

describe('fixed catalog transport and permissions', () => {
  it('reads list and single records and sends a PUT without changing serialized bytes', async () => {
    const { client, requests } = fixture();
    expect(await client.products()).toEqual([product]); expect(await client.product(id)).toEqual(product);
    expect(await client.saveProductPrice(id, body)).toEqual(product);
    expect(requests.map(r => [r.options.method, r.url])).toEqual([
      ['GET', `${ADMIN_ORIGIN}/api/products`], ['GET', `${ADMIN_ORIGIN}/api/products/${id}`], ['PUT', `${ADMIN_ORIGIN}/api/products/${id}`],
    ]);
    expect(requests[2]?.options.body).toBe(body);
    expect(requests.every(r => r.options.redirect === 'error' && (r.options.headers as Record<string, string>).Origin === ADMIN_ORIGIN)).toBe(true);
  });
  it('keeps stock, product-read and product-price permissions independent', async () => {
    const { client, requests } = fixture();
    client.account = { ...account, permissions: ['content.manage'] };
    await expect(client.products()).rejects.toMatchObject({ status: 403 });
    await expect(client.product(id)).rejects.toMatchObject({ status: 403 });
    client.account = { ...account, permissions: ['products.manage'] };
    expect(await client.products()).toEqual([product]);
    await expect(client.books()).rejects.toMatchObject({ status: 403 });
    await expect(client.saveProductPrice(id, body)).rejects.toMatchObject({ status: 403 });
    client.account = { ...account, permissions: ['pricing.manage'] };
    await expect(client.saveProductPrice(id, body)).rejects.toMatchObject({ status: 403 });
    client.account = { ...account, permissions: ['products.manage', 'pricing.manage'] };
    expect(await client.saveProductPrice(id, body)).toEqual(product); expect(requests).toHaveLength(2);
  });
  it.each([null, { ...account, mustChangePassword: true }])('requires an authenticated account with no forced password change', async accountValue => {
    const { client, requests } = fixture(); client.account = accountValue;
    for (const action of [() => client.products(), () => client.product(id), () => client.saveProductPrice(id, body)]) {
      await expect(action()).rejects.toMatchObject({ status: accountValue === null ? 401 : 428 });
    }
    expect(requests).toHaveLength(0);
  });
  it.each(['https://evil.invalid', '../auth/session', `${id}?includeDeleted=true`, `${id}/listing`, `${id}#suffix`, '%2f%2fevil.invalid', 'not-a-uuid'])('rejects unsafe product identifiers: %s', async invalid => {
    const { client, requests } = fixture();
    await expect(client.product(invalid)).rejects.toMatchObject({ status: 400 });
    await expect(client.saveProductPrice(invalid, body)).rejects.toMatchObject({ status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each([
    ['GET', 'https://evil.invalid/api/products'], ['GET', '/api/products?includeDeleted=true'], ['GET', '/api/products/../auth/session'],
    ['DELETE', `/api/products/${id}`], ['POST', '/api/products'], ['PUT', '/api/products'],
    ['GET', `/api/products/${id}/inventory`], ['PUT', `/api/products/${id}/listing`], ['PUT', `/api/products/media/${id}`],
    ['GET', '/api/products/media/not-an-id'], ['POST', '/api/auth/session'], ['GET', '/api/auth/login'],
  ])('rejects any transport method/path outside the fixed allowlist: %s %s', async (method, route) => {
    const { client, requests } = fixture();
    const internal = client as unknown as { fetchResponse(method: string, route: string): Promise<Response> };
    await expect(internal.fetchResponse(method, route)).rejects.toMatchObject({ status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each([302, 307, 308])('refuses redirect responses before accepting cookies (%i)', async status => {
    const { client, vault, requests } = fixture(async () => new Response(null, { status, headers: { location: 'https://evil.invalid', 'set-cookie': '__Host-amane_admin_session=unsafe; Secure; Path=/' } }));
    await expect(client.products()).rejects.toMatchObject({ status: 502 }); expect(vault.save).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  });
  it.each([{ url: 'https://evil.invalid/api/products', redirected: false }, { url: `${ADMIN_ORIGIN}/api/products`, redirected: true }])('rejects responses that bypassed redirect:error %#', async attributes => {
    const result = response({ items: [product] }, 200, { 'set-cookie': '__Host-amane_admin_session=unsafe; Secure; Path=/' });
    Object.defineProperties(result, { url: { value: attributes.url }, redirected: { value: attributes.redirected } });
    const { client, vault } = fixture(async () => result);
    await expect(client.products()).rejects.toMatchObject({ status: 502 }); expect(vault.save).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 410, 500])('returns catalog failures without inventory recreation or retry (%i)', async status => {
    const { client, requests } = fixture(async () => response({ error: 'STOCK_REQUEST_FAILED' }, status));
    await expect(client.saveProductPrice(id, body)).rejects.toMatchObject({ status, inventoryMissing: false }); expect(requests).toHaveLength(1);
  });
  it('does not retry a network failure or change the journal body', async () => {
    const { client, requests } = fixture(async () => { throw new Error('synthetic offline'); });
    await expect(client.saveProductPrice(id, body)).rejects.toThrow('synthetic offline');
    expect(requests).toHaveLength(1); expect(requests[0]?.options.body).toBe(body);
  });
});

describe('catalog response and request validation', () => {
  it.each([
    { id: 'bad' }, { id: sourceBookId }, { version: 0 }, { version: 1.2 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { sourceBookId: 'bad' }, { sourceBookId: null }, { sourceBarcode: null }, { sourceBarcode: '' }, { sourceBarcode: 'a\nb' },
    { sourceBarcode: 'a'.repeat(129) }, { sourceBarcode: '__proto__' }, { shopRegistered: 'yes' }, { shopRegistered: undefined },
    { deletedAt: undefined }, { deletedAt: 'not-a-date' }, { listed: 'yes' }, { stock: -1 }, { content: null },
    { content: { ...content, currency: 'USD' } }, { content: { ...content, name: '' } }, { content: { ...content, imageId: 'bad' } },
    { content: { ...content, originalCents: 100_000_001 } }, { content: { ...content, currentCents: 1001 } },
    { content: { ...content, currentCents: 1.2 } }, { content: { ...content, discountBps: 1 } },
    { content: { ...content, priceSource: 'unknown' } }, { content: { ...content, categoryId: 'bad' } },
    { content: { ...content, priceSource: 'discount', currentCents: 799 } },
    { content: { ...content, originalCents: 0, currentCents: 0, discountBps: 1 } },
  ])('rejects malformed or noncanonical product fields %#', async changes => {
    const { client } = fixture(async () => response({ ...product, ...changes }));
    await expect(client.product(id)).rejects.toMatchObject({ status: 502, inventoryMissing: false });
  });
  it.each([
    null, [], {}, { items: null }, { items: 'bad' }, { items: [{ ...product, version: 0 }] }, { items: [product, product] },
  ])('rejects malformed product lists and duplicate IDs %#', async payload => {
    const { client } = fixture(async () => response(payload)); await expect(client.products()).rejects.toMatchObject({ status: 502 });
  });
  it('accepts canonical discount rounding, zero price, nullable source and deleted records', async () => {
    const items = [
      { ...product, content: { ...content, originalCents: 333, currentCents: 300, discountBps: 1000, priceSource: 'discount', categoryId: sourceBookId } },
      { ...product, id: sourceBookId, sourceBookId: null, sourceBarcode: null, deletedAt: '2026-09-23T00:00:00.000Z', content: { ...content, originalCents: 0, currentCents: 0, discountBps: 0 } },
    ];
    const { client } = fixture(async () => response({ items })); expect(await client.products()).toEqual(items);
  });
  it.each([
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify(product), { headers: { 'content-type': 'text/html' } }),
  ])('rejects malformed JSON or non-JSON catalog responses %#', async result => {
    const { client } = fixture(async () => result); await expect(client.product(id)).rejects.toMatchObject({ status: 502 });
  });
  it('retains the bounded response size', async () => {
    const { client } = fixture(async () => response({ items: [] }, 200, { 'content-length': String(20 * 1024 * 1024 + 1) }));
    await expect(client.products()).rejects.toMatchObject({ status: 413 });
  });
  it.each([
    '{broken', JSON.stringify({ content, requestKey, version: 0 }), JSON.stringify({ content, requestKey: 'bad', version: 3 }),
    JSON.stringify({ content: { ...content, currency: 'USD' }, requestKey, version: 3 }),
    JSON.stringify({ content: { ...content, categoryId: sourceBookId }, requestKey, version: 3 }),
    JSON.stringify({ content, requestKey, version: 3, listed: false }), ' '.repeat(16 * 1024 + 1),
  ])('rejects an invalid write before network activity %#', async invalid => {
    const { client, requests } = fixture(); await expect(client.saveProductPrice(id, invalid)).rejects.toMatchObject({ status: 400, definitiveRejection: true }); expect(requests).toHaveLength(0);
  });
  it('validates the PUT response identity and content too', async () => {
    const { client } = fixture(async () => response({ ...product, id: sourceBookId }));
    await expect(client.saveProductPrice(id, body)).rejects.toMatchObject({ status: 502 });
  });
});
