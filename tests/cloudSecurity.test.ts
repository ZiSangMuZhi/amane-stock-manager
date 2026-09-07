import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, CloudClient } from '../src/main/cloudClient';
import { JournalStore, TokenVault } from '../src/main/cloudStore';
import { isTrustedSender } from '../src/main/trustedIpc';
import { SyncJournal } from '../src/main/cloudSync';

const dirs: string[] = [];
async function temporaryFile(name: string) { const dir = await mkdtemp(path.join(tmpdir(), 'amane-cloud-test-')); dirs.push(dir); return path.join(dir, name); }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const encryption = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (s: Buffer) => Buffer.from(s).reverse().toString('utf8') };
const account = { id: 'account-a', username: 'synthetic', displayName: 'Synthetic test account', mustChangePassword: false, permissions: ['content.manage'] };

describe('main-process authentication and IPC boundaries', () => {
  it('stores only encrypted tokens and never falls back to plaintext or basic_text', async () => {
    const file = await temporaryFile('session.encrypted'), vault = new TokenVault(file, encryption);
    await vault.save('synthetic-secret'); expect((await readFile(file)).toString()).not.toContain('synthetic-secret'); expect(await vault.load()).toBe('synthetic-secret');
    const unavailable = new TokenVault(file, { ...encryption, getSelectedStorageBackend: () => 'basic_text' });
    expect(unavailable.available).toBe(false); await unavailable.save('synthetic-secret'); expect(await unavailable.load()).toBeNull();
    await expect(readFile(file)).rejects.toThrow();
    const broken = new TokenVault(file, { ...encryption, encryptString: () => { throw new Error('OS key failure'); } });
    await expect(broken.save('do-not-save')).rejects.toThrow('OS key failure'); await expect(readFile(file)).rejects.toThrow();
  });

  it('pins HTTPS requests, sends cookie and CSRF only in main, and clears local login even when logout fails', async () => {
    const file = await temporaryFile('session.encrypted');
    const requests: { url: string; options: RequestInit }[] = [];
    const transport: typeof fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/logout')) throw new Error('offline logout');
      const headers = new Headers({ 'content-type': 'application/json' });
      if (String(url).endsWith('/login')) {
        headers.append('set-cookie', '__Host-amane_admin_session=synthetic-session; Path=/; Secure; HttpOnly');
        headers.append('set-cookie', '__Host-amane_admin_csrf=synthetic-csrf; Path=/; Secure');
        headers.append('set-cookie', 'ignored-cookie=untrusted; Path=/');
      }
      return new Response(JSON.stringify(String(url).endsWith('/stock-books') ? { items: [] } : { authenticated: true, account }), { status: 200, headers });
    };
    const client = new CloudClient(new TokenVault(file, encryption), transport);
    await client.login('synthetic', 'ephemeral-password'); await client.books();
    expect(requests.every(r => r.url.startsWith(`${ADMIN_ORIGIN}/api/`) && r.options.redirect === 'error')).toBe(true);
    const headers = requests[1]!.options.headers as Record<string,string>;
    expect(headers.Cookie).toContain('__Host-amane_admin_session=synthetic-session'); expect(headers.Cookie).not.toContain('ignored-cookie');
    expect(headers['X-CSRF-Token']).toBe('synthetic-csrf'); expect(JSON.stringify(client.account)).not.toContain('synthetic-session');
    expect((await readFile(file)).toString()).not.toContain('ephemeral-password');
    await expect(client.stock('GET', 'https://evil.invalid', undefined)).rejects.toThrow(); expect(requests).toHaveLength(2);
    await expect(client.logout()).rejects.toThrow('offline logout'); expect(client.account).toBeNull(); await expect(readFile(file)).rejects.toThrow();
  });

  it('restores a saved session only after a server session check and adopts the current account', async () => {
    const vault = new TokenVault(await temporaryFile('session.encrypted'), encryption);
    await vault.save(JSON.stringify({ '__Host-amane_admin_session': 'synthetic-session', '__Host-amane_admin_csrf': 'synthetic-csrf' }));
    let url = '';
    const client = new CloudClient(vault, async target => { url = String(target); return new Response(JSON.stringify({ authenticated: true, account: { ...account, id: 'new-account' } })); });
    expect(client.account).toBeNull(); await client.restore(); expect(url).toBe(`${ADMIN_ORIGIN}/api/auth/session`); expect(client.account?.id).toBe('new-account');
  });

  it('allows only the current application main frame, rejecting other windows, subframes, paths and origins', () => {
    const sender = {}, frame = { url: 'file:///C:/app/renderer/index.html' };
    expect(isTrustedSender({ sender, senderFrame: frame }, sender, frame, frame.url)).toBe(true);
    expect(isTrustedSender({ sender: {}, senderFrame: frame }, sender, frame, frame.url)).toBe(false);
    expect(isTrustedSender({ sender, senderFrame: { ...frame } }, sender, frame, frame.url)).toBe(false);
    expect(isTrustedSender({ sender, senderFrame: null }, sender, frame, frame.url)).toBe(false);
    expect(isTrustedSender({ sender, senderFrame: frame }, sender, frame, 'file:///C:/evil/index.html')).toBe(false);
    frame.url = 'https://evil.invalid/'; expect(isTrustedSender({ sender, senderFrame: frame }, sender, frame, 'file:///C:/app/renderer/index.html')).toBe(false);
  });

  it('binds durable journals to account, path and inventory ID, including rename', async () => {
    const store = new JournalStore(await temporaryFile('journal.json')); await store.load();
    const journal: SyncJournal = { accountId: 'a', filePath: 'C:/synthetic/one.json', inventoryId: 'book-a', version: 3, baseHash: 'hash', pending: { method: 'PUT', body: 'exact bytes', requestKey: 'same-key', version: 3, hash: 'pending-hash' }, conflict: false, lastSuccess: null };
    await store.save(journal);
    expect(store.find('b', journal.filePath, 'book-a')).toBeUndefined(); expect(store.find('a', 'C:/synthetic/other.json', 'book-a')).toBeUndefined(); expect(store.find('a', journal.filePath, 'book-b')).toBeUndefined();
    const oldPath = journal.filePath; journal.filePath = 'C:/synthetic/renamed.json'; await store.save(journal, oldPath);
    expect(store.find('a', oldPath, 'book-a')).toBeUndefined(); expect(store.find('a', journal.filePath, 'book-a')?.pending?.body).toBe('exact bytes');
  });
});
