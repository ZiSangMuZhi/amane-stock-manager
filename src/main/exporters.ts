import { promises as fs } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { ExportFormat, InventoryFile, InventoryItem } from '../shared/types';

const ITEM_HEADERS = [
  'barcode',
  'nickname',
  'lookupName',
  'brand',
  'category',
  'imageUrl',
  'lookupSource',
  'lookupConfidence',
  'quantityOnHand',
  'totalIn',
  'totalOut',
  'lookupStatus',
  'firstInAt',
  'lastInAt',
  'lastOutAt',
  'lookupUpdatedAt'
];

const TRANSACTION_HEADERS = [
  'id',
  'barcode',
  'type',
  'timestamp',
  'quantityChange',
  'quantityAfter',
  'lookupNameAtTime',
  'nicknameAtTime'
];

export async function exportInventoryFile(
  inventory: InventoryFile,
  format: ExportFormat,
  destinationPath: string
): Promise<void> {
  if (format === 'json') {
    await fs.writeFile(destinationPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf-8');
    return;
  }

  if (format === 'xlsx') {
    await exportXlsx(inventory, destinationPath);
    return;
  }

  const headers = format === 'csv-items' ? ITEM_HEADERS : TRANSACTION_HEADERS;
  const rows = format === 'csv-items' ? itemRows(inventory) : transactionRows(inventory);
  await fs.writeFile(destinationPath, csvFromRows(rows, headers), 'utf-8');
}

export function defaultExportName(inventoryName: string, format: ExportFormat): string {
  const safeName = inventoryName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'inventory';
  const extension = format === 'xlsx' ? 'xlsx' : format === 'json' ? 'json' : 'csv';
  const suffix = format === 'csv-transactions' ? '-transactions' : format === 'csv-items' ? '-items' : '';
  return `${safeName}${suffix}.${extension}`;
}

function itemRows(inventory: InventoryFile): Array<Record<string, string | number>> {
  return sortedItems(inventory).map((item) => ({
    barcode: item.barcode,
    nickname: item.nickname,
    lookupName: item.lookupName,
    brand: item.brand,
    category: item.category,
    imageUrl: item.imageUrl,
    lookupSource: item.lookupSource,
    lookupConfidence: item.lookupConfidence,
    quantityOnHand: item.quantityOnHand,
    totalIn: item.totalIn,
    totalOut: item.totalOut,
    lookupStatus: item.lookupStatus,
    firstInAt: item.firstInAt ?? '',
    lastInAt: item.lastInAt ?? '',
    lastOutAt: item.lastOutAt ?? '',
    lookupUpdatedAt: item.lookupUpdatedAt ?? ''
  }));
}

function transactionRows(inventory: InventoryFile): Array<Record<string, string | number>> {
  return inventory.transactions.map((transaction) => ({
    id: transaction.id,
    barcode: transaction.barcode,
    type: transaction.type,
    timestamp: transaction.timestamp,
    quantityChange: transaction.quantityChange,
    quantityAfter: transaction.quantityAfter,
    lookupNameAtTime: transaction.lookupNameAtTime,
    nicknameAtTime: transaction.nicknameAtTime
  }));
}

async function exportXlsx(inventory: InventoryFile, destinationPath: string): Promise<void> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': xmlFile(contentTypesXml()),
    '_rels/.rels': xmlFile(rootRelsXml()),
    'docProps/app.xml': xmlFile(appPropsXml()),
    'docProps/core.xml': xmlFile(corePropsXml()),
    'xl/workbook.xml': xmlFile(workbookXml()),
    'xl/_rels/workbook.xml.rels': xmlFile(workbookRelsXml()),
    'xl/worksheets/sheet1.xml': xmlFile(sheetXml(itemRows(inventory), ITEM_HEADERS)),
    'xl/worksheets/sheet2.xml': xmlFile(sheetXml(transactionRows(inventory), TRANSACTION_HEADERS))
  };

  await fs.writeFile(destinationPath, Buffer.from(zipSync(files)));
}

function csvFromRows(rows: Array<Record<string, string | number>>, headers: string[]): string {
  const lines = [
    headers.map(escapeCsvValue).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header] ?? '')).join(','))
  ];
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function escapeCsvValue(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sortedItems(inventory: InventoryFile): InventoryItem[] {
  return Object.values(inventory.items).sort((a, b) => {
    if (b.quantityOnHand !== a.quantityOnHand) {
      return b.quantityOnHand - a.quantityOnHand;
    }
    return a.barcode.localeCompare(b.barcode);
  });
}

function xmlFile(xml: string): Uint8Array {
  return strToU8(xml);
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Items" sheetId="1" r:id="rId1"/>
    <sheet name="Transactions" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;
}

function workbookRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;
}

function appPropsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Amane Stock Manager</Application>
</Properties>`;
}

function corePropsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Amane Stock Manager</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;
}

function sheetXml(rows: Array<Record<string, string | number>>, headers: string[]): string {
  const allRows = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))];
  const rowXml = allRows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => cellXml(value, rowIndex + 1, columnIndex + 1))
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function cellXml(value: string | number, row: number, column: number): string {
  const ref = `${columnName(column)}${row}`;
  if (typeof value === 'number') {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function columnName(index: number): string {
  let value = index;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
