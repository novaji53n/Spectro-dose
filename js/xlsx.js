/**
 * xlsx.js — ตัวอ่าน/เขียนไฟล์ .xlsx แบบไม่ต้องพึ่งไลบรารีภายนอก
 * - buildXlsx(): สร้างไฟล์ .xlsx (ZIP แบบ store) จาก sheets ของ rows
 * - readXlsx():  อ่านไฟล์ .xlsx (รองรับ deflate ผ่าน DecompressionStream)
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ */
/* utility                                                             */
/* ------------------------------------------------------------------ */

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec2) => String.fromCodePoint(Number(dec2)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function colIndex(ref) {
  const letters = String(ref).replace(/[^A-Za-z]/g, '').toUpperCase();
  let value = 0;
  for (let i = 0; i < letters.length; i += 1) value = value * 26 + (letters.charCodeAt(i) - 64);
  return value - 1;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/* ------------------------------------------------------------------ */
/* ZIP writer (store only)                                             */
/* ------------------------------------------------------------------ */

function zipStore(files, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    locals.push(local, data);
    centrals.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const entry of centrals) {
    const record = new Uint8Array(46 + entry.nameBytes.length);
    const dv = new DataView(record.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, day, true);
    dv.setUint32(16, entry.crc, true);
    dv.setUint32(20, entry.size, true);
    dv.setUint32(24, entry.size, true);
    dv.setUint16(28, entry.nameBytes.length, true);
    dv.setUint32(42, entry.offset, true);
    record.set(entry.nameBytes, 46);
    cdParts.push(record);
    cdSize += record.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of locals) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of cdParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

/* ------------------------------------------------------------------ */
/* XLSX writer                                                         */
/* ------------------------------------------------------------------ */

function sheetXml(rows, hasDrawing) {
  const body = rows
    .map((row, rowIndex) => {
      const cells = (row || [])
        .map((value, colIdx) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${colName(colIdx)}${rowIndex + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const drawing = hasDrawing ? '<drawing r:id="rId1"/>' : '';
  const xmlnsR = hasDrawing ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '';
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${xmlnsR}><sheetData>${body}</sheetData>${drawing}</worksheet>`;
}

function imageBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string' && data.startsWith('data:')) {
    const base64 = data.slice(data.indexOf(',') + 1);
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('รูปภาพต้องเป็น dataURL หรือ Uint8Array');
}

function drawingXml(images) {
  const anchors = images
    .map((image, index) => {
      const cx = Math.round((Number(image.width) || 900) * 9525);
      const cy = Math.round((Number(image.height) || 280) * 9525);
      const fromCol = Number(image.fromCol) || 0;
      const fromRow = Number(image.fromRow) || 0;
      return (
        '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        '<xdr:pic><xdr:nvPicPr>' +
        `<xdr:cNvPr id="${index + 2}" name="Chart ${index + 1}"/>` +
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>' +
        '</xdr:nvPicPr>' +
        `<xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
      );
    })
    .join('');
  return (
    `${XML_HEADER}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `${anchors}</xdr:wsDr>`
  );
}

const STYLES_XML =
  `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * สร้างไฟล์ .xlsx (รองรับรูปภาพฝังในชีตผ่าน sheet.images)
 * @param {{name: string, rows: (string|number|null)[][], images?: {data: string|Uint8Array, width: number, height: number, fromCol?: number, fromRow?: number}[]}[]} sheets
 * @returns {Uint8Array}
 */
export function buildXlsx(sheets, options = {}) {
  const list = (sheets || []).filter((s) => s && Array.isArray(s.rows));
  if (list.length === 0) throw new Error('ต้องมีอย่างน้อย 1 ชีต');

  const files = [];
  const sheetCount = list.length;

  let mediaIndex = 0;
  const drawings = [];
  list.forEach((sheet, sheetIndex) => {
    if (!Array.isArray(sheet.images) || sheet.images.length === 0) return;
    const images = sheet.images.map((image) => {
      mediaIndex += 1;
      return { ...image, mediaName: `image${mediaIndex}.png`, bytes: imageBytes(image.data) };
    });
    drawings.push({ sheetIndex, drawingNo: drawings.length + 1, images });
  });
  const hasImages = drawings.length > 0;

  const contentTypes = [
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    hasImages ? '<Default Extension="png" ContentType="image/png"/>' : '',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    list
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join(''),
    drawings
      .map((d) => `<Override PartName="/xl/drawings/drawing${d.drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`)
      .join(''),
    '</Types>',
  ].join('');

  const rootRels =
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbookRels = [
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    ...list.map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ),
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    '</Relationships>',
  ].join('');

  const workbook =
    `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    list
      .map((sheet, i) => `<sheet name="${escapeXml((sheet.name || `Sheet${i + 1}`).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>';

  files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypes) });
  files.push({ name: '_rels/.rels', data: enc.encode(rootRels) });
  files.push({ name: 'xl/workbook.xml', data: enc.encode(workbook) });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) });
  files.push({ name: 'xl/styles.xml', data: enc.encode(STYLES_XML) });

  drawings.forEach((drawing) => {
    files.push({ name: `xl/drawings/drawing${drawing.drawingNo}.xml`, data: enc.encode(drawingXml(drawing.images)) });

    const drawingRels =
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      drawing.images
        .map(
          (image, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${image.mediaName}"/>`,
        )
        .join('') +
      '</Relationships>';
    files.push({ name: `xl/drawings/_rels/drawing${drawing.drawingNo}.xml.rels`, data: enc.encode(drawingRels) });

    drawing.images.forEach((image) => {
      files.push({ name: `xl/media/${image.mediaName}`, data: image.bytes });
    });

    const sheetRels =
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawing.drawingNo}.xml"/>` +
      '</Relationships>';
    files.push({ name: `xl/worksheets/_rels/sheet${drawing.sheetIndex + 1}.xml.rels`, data: enc.encode(sheetRels) });
  });

  const drawingSheets = new Set(drawings.map((drawing) => drawing.sheetIndex));
  list.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(sheet.rows, drawingSheets.has(i))) });
  });

  return zipStore(files, options.createdAt || new Date());
}

/* ------------------------------------------------------------------ */
/* ZIP reader                                                          */
/* ------------------------------------------------------------------ */

function findEocd(bytes) {
  const min = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์ไม่รองรับการแตกไฟล์ .xlsx');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function unzip(bytes) {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error('ไฟล์ไม่ใช่ .xlsx ที่ถูกต้อง');

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(offset, true) !== 0x02014b50) break;
    const method = dv.getUint16(offset + 10, true);
    const compSize = dv.getUint32(offset + 20, true);
    const nameLen = dv.getUint16(offset + 28, true);
    const extraLen = dv.getUint16(offset + 30, true);
    const commentLen = dv.getUint16(offset + 32, true);
    const localOffset = dv.getUint32(offset + 42, true);
    const name = dec.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const files = new Map();
  for (const [name, entry] of entries) {
    const lo = entry.localOffset;
    if (dv.getUint32(lo, true) !== 0x04034b50) continue;
    const nameLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + entry.compSize);
    const data = entry.method === 0 ? raw : await inflateRaw(raw);
    files.set(name, data);
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* XML helpers (regex-based, ใช้ได้ทั้งเบราว์เซอร์และ Node)            */
/* ------------------------------------------------------------------ */

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? unescapeXml(match[1]) : null;
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(xml))) {
    const rowTitle = rowMatch[0].slice(0, rowMatch[0].indexOf('>'));
    const rowIndex = Number(attr(rowTitle, 'r')) || rows.length + 1;
    const cells = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const ref = attr(attrs, 'r') || '';
      const type = attr(attrs, 't') || '';
      let value = '';

      if (type === 'inlineStr') {
        const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
        value = texts.join('');
      } else {
        const vm = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = vm ? unescapeXml(vm[1]) : '';
        if (type === 's') {
          const idx = Number(raw);
          value = Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else {
          value = raw;
        }
      }

      cells[colIndex(ref)] = value;
    }

    rows[rowIndex - 1] = Array.from(cells, (v) => (v === undefined ? '' : v));
  }

  return Array.from(rows, (row) => row || []);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(''),
  );
}

/**
 * อ่านไฟล์ .xlsx
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{sheets: {name: string, rows: string[][]}[]}>}
 */
export async function readXlsx(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = await unzip(bytes);
  const get = (name) => (files.has(name) ? dec.decode(files.get(name)) : '');

  const workbook = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const shared = parseSharedStrings(get('xl/sharedStrings.xml'));

  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relMap.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], 'name') || `Sheet${sheets.length + 1}`;
    const rid = m[0].match(/r:id\s*=\s*"([^"]+)"/);
    let path = rid ? relMap.get(rid[1]) : null;
    if (!path || !files.has(path)) {
      const fallback = `xl/worksheets/sheet${sheets.length + 1}.xml`;
      path = files.has(fallback) ? fallback : [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
    }
    if (!path) continue;
    sheets.push({ name, rows: parseSheetXml(get(path), shared) });
  }

  if (sheets.length === 0) throw new Error('ไม่พบชีตในไฟล์ .xlsx');
  return { sheets };
}
