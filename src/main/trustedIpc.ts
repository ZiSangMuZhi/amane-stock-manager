export interface SenderEvent { sender: unknown; senderFrame: { url: string } | null }

export function isTrustedSender(event: SenderEvent, webContents: unknown, mainFrame: unknown, expectedUrl: string): boolean {
  if (!webContents || event.sender !== webContents || !event.senderFrame || event.senderFrame !== mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url), expected = new URL(expectedUrl);
    return actual.protocol === expected.protocol && actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search;
  } catch { return false; }
}
