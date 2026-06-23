import { ProductLookupResult, ProductLookupSource } from '../shared/types';

const LOOKUP_TIMEOUT_MS = 6500;
const OPEN_FOOD_FACTS_URL = 'https://world.openfoodfacts.org/api/v3.6/product';
const UPCITEMDB_URL = 'https://api.upcitemdb.com/prod/trial/lookup';
const DUCKDUCKGO_HTML_URL = 'https://duckduckgo.com/html/';
const APP_USER_AGENT = 'AmaneStockManager/0.1.7 (local-desktop-app)';

export async function lookupBarcode(barcode: string): Promise<ProductLookupResult> {
  const results = await lookupProviders(barcode);
  const found = results.find((result) => result.status === 'found');
  if (found) {
    return found;
  }

  const error = results.find((result) => result.status === 'error');
  if (error && results.every((result) => result.status === 'error')) {
    return error;
  }

  return notFoundResult(barcode, 'none');
}

async function lookupProviders(barcode: string): Promise<ProductLookupResult[]> {
  const upcItemDb = await lookupUpcItemDb(barcode);
  if (upcItemDb.status === 'found') {
    return [upcItemDb];
  }

  const openFoodFacts = await lookupOpenFoodFacts(barcode);
  if (openFoodFacts.status === 'found') {
    return [upcItemDb, openFoodFacts];
  }

  const webSearch = await lookupWebSearch(barcode);
  return [upcItemDb, openFoodFacts, webSearch];
}

async function lookupUpcItemDb(barcode: string): Promise<ProductLookupResult> {
  try {
    const url = `${UPCITEMDB_URL}?upc=${encodeURIComponent(barcode)}`;
    const payload = await fetchJsonWithTimeout<UpcItemDbResponse>(url, {
      Accept: 'application/json',
      'User-Agent': APP_USER_AGENT
    });
    const item = payload.items?.[0];
    const productName = cleanTitle(item?.title ?? '');

    if (!item || !productName) {
      return notFoundResult(barcode, 'upcitemdb');
    }

    return {
      barcode,
      status: 'found',
      productName,
      brand: normalizeBrand(item.brand, productName),
      category: item.category?.trim() ?? '',
      imageUrl: item.images?.[0]?.trim() ?? '',
      source: 'upcitemdb',
      confidence: 0.95,
      lookedUpAt: new Date().toISOString()
    };
  } catch (error) {
    return errorResult(barcode, 'upcitemdb', error);
  }
}

async function lookupOpenFoodFacts(barcode: string): Promise<ProductLookupResult> {
  try {
    const fields = 'product_name,product_name_en,product_name_zh,product_name_ja,brands,categories,image_front_url';
    const url = `${OPEN_FOOD_FACTS_URL}/${encodeURIComponent(barcode)}.json?fields=${fields}`;
    const payload = await fetchJsonWithTimeout<OpenFoodFactsResponse>(url, {
      Accept: 'application/json',
      'User-Agent': APP_USER_AGENT
    });
    const product = payload.product;
    const found = Boolean(product) && payload.status !== 0 && payload.result?.id !== 'product_not_found';

    if (!found || !product) {
      return notFoundResult(barcode, 'openfoodfacts');
    }

    const productName =
      firstText(product.product_name_zh, product.product_name_ja, product.product_name_en, product.product_name) ||
      '';

    if (!productName) {
      return notFoundResult(barcode, 'openfoodfacts');
    }

    return {
      barcode,
      status: 'found',
      productName: cleanTitle(productName),
      brand: firstText(product.brands) || '',
      category: firstText(product.categories) || '',
      imageUrl: firstText(product.image_front_url) || '',
      source: 'openfoodfacts',
      confidence: 0.82,
      lookedUpAt: new Date().toISOString()
    };
  } catch (error) {
    return errorResult(barcode, 'openfoodfacts', error);
  }
}

async function lookupWebSearch(barcode: string): Promise<ProductLookupResult> {
  try {
    const query = `${barcode} Bandai Gundam Gunpla`;
    const response = await fetchTextWithTimeout(`${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}`, {
      Accept: 'text/html',
      'User-Agent': APP_USER_AGENT
    });
    const title = extractBestWebTitle(response, barcode);

    if (!title) {
      return notFoundResult(barcode, 'web_search');
    }

    return {
      barcode,
      status: 'found',
      productName: title,
      brand: inferBrand(title),
      category: inferCategory(title),
      imageUrl: '',
      source: 'web_search',
      confidence: 0.62,
      lookedUpAt: new Date().toISOString()
    };
  } catch (error) {
    return errorResult(barcode, 'web_search', error);
  }
}

async function fetchJsonWithTimeout<T>(url: string, headers: Record<string, string>): Promise<T> {
  const text = await fetchTextWithTimeout(url, headers);
  return JSON.parse(text) as T;
}

async function fetchTextWithTimeout(url: string, headers: Record<string, string>): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function notFoundResult(barcode: string, source: ProductLookupSource): ProductLookupResult {
  return {
    barcode,
    status: 'not_found',
    productName: '',
    brand: '',
    category: '',
    imageUrl: '',
    source,
    confidence: 0,
    lookedUpAt: new Date().toISOString()
  };
}

function errorResult(barcode: string, source: ProductLookupSource, error: unknown): ProductLookupResult {
  return {
    barcode,
    status: 'error',
    productName: '',
    brand: '',
    category: '',
    imageUrl: '',
    source,
    confidence: 0,
    lookedUpAt: new Date().toISOString(),
    errorMessage: error instanceof Error ? error.message : 'Unknown lookup error'
  };
}

function extractBestWebTitle(html: string, barcode: string): string {
  const titles = [...html.matchAll(/<a[^>]+class="result__a"[^>]*>(.*?)<\/a>/gis)]
    .map((match) => htmlToText(match[1] ?? ''))
    .map((title) => cleanTitle(title))
    .filter(Boolean)
    .filter((title) => !/barcode lookup|upcitemdb|search results/i.test(title));

  const scored = titles
    .map((title) => ({ title, score: scoreTitle(title, barcode) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.title ?? '';
}

function scoreTitle(title: string, barcode: string): number {
  const normalized = title.toLowerCase();
  let score = 0;
  if (title.includes(barcode)) score += 1;
  if (normalized.includes('gundam')) score += 3;
  if (normalized.includes('gunpla')) score += 2;
  if (normalized.includes('bandai')) score += 2;
  if (normalized.includes('hg') || normalized.includes('high grade')) score += 1;
  if (/1[:/ ]?144/.test(normalized)) score += 1;
  if (normalized.includes('model kit')) score += 1;
  return score;
}

function cleanTitle(value: string): string {
  return htmlToText(value)
    .replace(/\s*[-|]\s*(amazon|ebay|target|barcode lookup|upcitemdb).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeBrand(brand: string | undefined, productName: string): string {
  const text = brand?.trim();
  if (text && !/^gundam$/i.test(text)) {
    return text;
  }
  return inferBrand(productName);
}

function inferBrand(title: string): string {
  if (/bandai spirits/i.test(title)) return 'BANDAI SPIRITS';
  if (/bandai/i.test(title)) return 'Bandai';
  if (/gundam/i.test(title)) return 'Gundam';
  return '';
}

function inferCategory(title: string): string {
  const parts = [];
  if (/gundam|gunpla/i.test(title)) parts.push('Gunpla');
  if (/model kit|plastic model|maquette/i.test(title)) parts.push('Model Kit');
  if (/hg|high grade/i.test(title)) parts.push('HG');
  if (/rg|real grade/i.test(title)) parts.push('RG');
  if (/mg|master grade/i.test(title)) parts.push('MG');
  return [...new Set(parts)].join(' / ');
}

function firstText(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

interface UpcItemDbResponse {
  code?: string;
  total?: number;
  items?: Array<{
    ean?: string;
    title?: string;
    brand?: string;
    category?: string;
    images?: string[];
  }>;
}

interface OpenFoodFactsResponse {
  status?: number;
  result?: { id?: string };
  product?: {
    product_name?: string;
    product_name_en?: string;
    product_name_zh?: string;
    product_name_ja?: string;
    brands?: string;
    categories?: string;
    image_front_url?: string;
  };
}
