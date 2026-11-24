/**
 * ตัวแยกวิเคราะห์บรรทัดข้อความที่เครื่องสเปกโตรโฟโตมิเตอร์ส่งออกมาทางพอร์ตอนุกรม
 * ทุกฟังก์ชันเป็น pure function เพื่อให้ทดสอบได้ด้วย node --test โดยไม่ต้องมีเบราว์เซอร์
 */

export const MODES = [
  { id: 'auto', label: 'อัตโนมัติ (ข้ามความยาวคลื่น/วันที่)' },
  { id: 'first', label: 'ตัวเลขตัวแรกในบรรทัด' },
  { id: 'last', label: 'ตัวเลขตัวสุดท้ายในบรรทัด' },
  { id: 'custom', label: 'กำหนดเอง (regex)' },
];

export const REASONS = {
  empty: 'บรรทัดว่าง',
  'no-number': 'ไม่พบตัวเลขในบรรทัด',
  'no-match': 'regex ไม่ตรงกับบรรทัดนี้',
  'bad-regex': 'regex ไม่ถูกต้อง',
};

const NUMBER_RE = /[-+]?\d+(?:[.,]\d+)?/g;

/** แปลงข้อความเป็นตัวเลข โดยรองรับจุดทศนิยมแบบจุลภาค (0,412 -> 0.412) */
export function toNumber(token) {
  if (token === null || token === undefined) return NaN;
  const text = String(token).trim().replace(/,/g, '.');
  if (!text) return NaN;
  return Number(text);
}

/**
 * เดาหน่วยของค่าที่อ่านได้: 'A' = absorbance, '%T' = transmittance
 * ถ้า regex ระบุหน่วยมาให้ (group ชื่อ unit) จะใช้ค่านั้นก่อน
 */
export function detectUnit(line, explicit) {
  const raw = explicit === null || explicit === undefined ? '' : String(explicit).trim().toUpperCase();

  if (raw) {
    if (raw.includes('%')) return '%T';
    if (raw === 'T' || raw === 'TRANS' || raw === 'TRANSMITTANCE') return '%T';
    if (raw === 'A' || raw === 'ABS' || raw === 'ABSORBANCE') return 'A';
    return raw;
  }

  const hasPercent = /%/.test(line);
  const hasAbs = /\bABS\b/i.test(line) || /[-+]?\d+(?:[.,]\d+)?\s*A\b/i.test(line);
  const hasTrans = /\bT\b/i.test(line);

  if (hasPercent && !hasAbs) return '%T';
  if (hasTrans && !hasAbs) return '%T';
  return 'A';
}

function result(ok, value, unit, text, reason) {
  return { ok, value: ok ? value : null, unit: ok ? unit : null, text: text ?? '', reason: reason ?? '' };
}

/**
 * ตัดข้อมูลรบกวนออกก่อนหา "ตัวเลขที่น่าจะเป็นค่าที่อ่านได้"
 * เช่น 600NM (ความยาวคลื่น), 23/11/2026 (วันที่), 17:11 (เวลา)
 */
function stripNoise(line) {
  return line
    .replace(/\b\d{1,4}\s*nm\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ');
}

/**
 * โหมดอัตโนมัติ: ถ้ามีตัวเลขที่มีจุดทศนิยมให้เลือกตัวสุดท้าย
 * (ค่าที่วัดได้มักมีทศนิยม ขณะที่รหัส/ลำดับมักเป็นจำนวนเต็ม) ถ้าไม่มีเลยให้ใช้ตัวสุดท้าย
 * และถ้าบรรทัดนั้นไม่มีทศนิยมเลย จะรับเฉพาะบรรทัดที่เป็น "ค่าเดียว" จริง ๆ
 * เพื่อไม่ให้บรรทัดสถานะอย่าง "GENESYS 20 READY" ถูกอ่านเป็นค่า 20
 */
function autoParse(line) {
  const cleaned = stripNoise(line);
  const tokens = [...cleaned.matchAll(NUMBER_RE)].map((m) => m[0]);
  if (tokens.length === 0) return result(false, null, null, '', 'no-number');

  const decimals = tokens.filter((t) => /[.,]/.test(t));
  const token = decimals.length > 0 ? decimals[decimals.length - 1] : tokens[tokens.length - 1];
  const value = toNumber(token);

  if (!Number.isFinite(value)) return result(false, null, null, token, 'no-number');

  if (decimals.length === 0) {
    const leftover = cleaned
      .replace(/^\s*(?:ABS|A|T|%T)\s+/i, '')
      .replace(/[-+]?\d+(?:[.,]\d+)?\s*(?:ABS|A|T|%T|%)?\s*$/i, '')
      .trim();
    if (/[A-Za-z]/.test(leftover)) return result(false, null, null, token, 'no-number');
  }

  return result(true, value, detectUnit(line), token, '');
}

/**
 * @param {string} rawLine ข้อความหนึ่งบรรทัดจากพอร์ต
 * @param {{mode?: string, regex?: string}} cfg
 * @returns {{ok: boolean, value: number|null, unit: string|null, text: string, reason: string}}
 */
export function parseLine(rawLine, cfg = {}) {
  const line = String(rawLine ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (!line) return result(false, null, null, '', 'empty');

  const mode = cfg.mode || 'auto';

  if (mode === 'custom') {
    let re;
    try {
      re = new RegExp(String(cfg.regex || ''), 'i');
    } catch {
      return result(false, null, null, '', 'bad-regex');
    }
    if (!String(cfg.regex || '').trim()) return result(false, null, null, '', 'bad-regex');

    const m = line.match(re);
    if (!m) return result(false, null, null, '', 'no-match');

    const rawValue = (m.groups && m.groups.value) ?? m[1];
    const rawUnit = (m.groups && m.groups.unit) ?? m[2];
    const value = toNumber(rawValue);
    if (!Number.isFinite(value)) return result(false, null, null, '', 'no-number');

    return result(true, value, detectUnit(line, rawUnit), String(rawValue), '');
  }

  if (mode === 'first' || mode === 'last') {
    const tokens = [...line.matchAll(NUMBER_RE)].map((m) => m[0]);
    if (tokens.length === 0) return result(false, null, null, '', 'no-number');

    const token = mode === 'first' ? tokens[0] : tokens[tokens.length - 1];
    const value = toNumber(token);
    if (!Number.isFinite(value)) return result(false, null, null, token, 'no-number');

    return result(true, value, detectUnit(line), token, '');
  }

  return autoParse(line);
}

/** แปลง %T เป็น absorbance (ใช้คำนวณโดสเมื่อเครื่องส่งค่า transmittance) */
export function toAbsorbance(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (unit !== '%T') return value;
  if (value <= 0) return null;
  const abs = -Math.log10(value / 100);
  return abs === 0 ? 0 : abs; // กันค่า -0
}

/** จัดรูปแบบค่าตามหน่วย: absorbance ทศนิยม 3 ตำแหน่ง, %T ทศนิยม 2 ตำแหน่ง */
export function formatValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return unit === '%T' ? value.toFixed(2) : value.toFixed(3);
}

export function formatDose(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}
