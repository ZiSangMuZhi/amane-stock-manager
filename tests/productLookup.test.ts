import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupBarcode } from '../src/main/productLookup';

describe('product lookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers UPCitemdb for gunpla barcode lookups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 'OK',
            total: 1,
            items: [
              {
                ean: '4573102661449',
                title: 'Mobile Suit Gundam Seed Destiny Abyss Gundam High Grade 1:144 Scale Model Kit',
                brand: 'Gundam',
                category: 'Toys',
                images: ['https://example.test/abyss.jpg']
              }
            ]
          })
      }))
    );

    const result = await lookupBarcode('4573102661449');

    expect(result.status).toBe('found');
    expect(result.source).toBe('upcitemdb');
    expect(result.productName).toContain('Abyss Gundam');
    expect(result.brand).toBe('Gundam');
    expect(result.confidence).toBeGreaterThan(0.9);
  });
});
