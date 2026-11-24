/**
 * calibration.js — ตารางสอบเทียบ (absorbance → dose) และการประมาณค่าในช่วง
 * เป็น pure functions ทั้งหมด เพื่อทดสอบได้ด้วย node --test
 */

/** แปลงข้อความเป็นตัวเลข รองรับทั้ง 0.123 / 0,123 / 1,234.5 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value === null || value === undefined) return NaN;

  let text = String(value).trim().replace(/\s/g, '').replace(/%$/, '');
  if (!text) return NaN;

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (hasComma) {
    text = text.replace(',', '.');
  }

  const num = Number(text);
  return Number.isFinite(num) ? num : NaN;
}

const UNIT_PATTERNS = [
  [/kgy/i, 'kGy'],
  [/mgy/i, 'mGy'],
  [/cgy/i, 'cGy'],
  [/(?<!k)(?<!m)(?<!c)gy/i, 'Gy'],
];

/** เดาหน่วยโดสจากข้อความหัวตาราง เช่น "Dose (kGy)" */
export function detectDoseUnit(text) {
  const value = String(text ?? '');
  for (const [pattern, unit] of UNIT_PATTERNS) {
    if (pattern.test(value)) return unit;
  }
  return '';
}

/**
 * อ่านตารางสอบเทียบตามรูปแบบมาตรฐานของเครื่องนี้
 *   คอลัมน์ A = absorbance, คอลัมน์ B = dose
 *   แถว 1 = หัวตาราง (ไม่ถูกอ่านเป็นข้อมูล)
 * ถ้าแถวแรกเป็นตัวเลขอยู่แล้ว (ไม่มีหัวตาราง) จะอ่านตั้งแต่แถวแรก
 *
 * @param {string[][]} rows
 * @returns {{points: {a:number,dose:number}[], aCol:number, doseCol:number, headerRow:number, skipped:number, unit:string}}
 */
export function buildCalibrationPoints(rows) {
  const data = (rows || []).filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''));
  if (data.length === 0) {
    return { points: [], aCol: 0, doseCol: 1, headerRow: -1, skipped: 0, unit: 'kGy' };
  }

  const aCol = 0;
  const doseCol = 1;

  // ---- หัวตาราง: แถวแรกถือเป็นหัวตารางถ้าช่อง A หรือ B ไม่ใช่ตัวเลข ----
  const firstA = parseNumber(data[0][aCol]);
  const firstDose = parseNumber(data[0][doseCol]);
  const hasHeader = !Number.isFinite(firstA) || !Number.isFinite(firstDose);
  const start = hasHeader ? 1 : 0;

  // ---- หน่วยโดส: อ่านจากหัวตาราง/ไม่กี่แถวแรก ----
  let unit = '';
  const scanLimit = Math.min(data.length, 5);
  for (let r = 0; r < scanLimit && !unit; r += 1) {
    unit = detectDoseUnit(data[r][doseCol]) || detectDoseUnit(data[r][aCol]);
  }
  if (!unit) unit = 'kGy';

  // ---- ข้อมูล: อ่านเฉพาะคอลัมน์ A และ B ----
  const points = [];
  let skipped = 0;
  for (let r = start; r < data.length; r += 1) {
    const a = parseNumber(data[r][aCol]);
    const dose = parseNumber(data[r][doseCol]);
    if (!Number.isFinite(a) || !Number.isFinite(dose)) {
      skipped += 1;
      continue;
    }
    points.push({ a, dose });
  }

  points.sort((p1, p2) => p1.a - p2.a);
  return { points, aCol, doseCol, headerRow: hasHeader ? 0 : -1, skipped, unit };
}

/**
 * ประมาณค่าโดสจากตาราง (linear interpolation, นอกช่วงใช้การต่อเส้นจากช่วงปลาย)
 * @param {number} absorbance
 * @param {{a:number,dose:number}[]} points
 */
export function doseFromPoints(absorbance, points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (!Number.isFinite(absorbance)) return null;
  if (points.length === 1) return points[0].dose;

  const at = (i) => points[i];
  const interp = (p0, p1) => {
    const span = p1.a - p0.a;
    if (span === 0) return p1.dose;
    const t = (absorbance - p0.a) / span;
    return p0.dose + t * (p1.dose - p0.dose);
  };

  if (absorbance <= at(0).a) return interp(at(0), at(1));
  for (let i = 1; i < points.length; i += 1) {
    if (absorbance <= at(i).a) return interp(at(i - 1), at(i));
  }
  return interp(at(points.length - 2), at(points.length - 1));
}

/** ตรวจว่าค่าอยู่นอกช่วงตารางหรือไม่ (ไว้เตือนผู้ใช้) */
export function isOutsideRange(absorbance, points) {
  if (!Array.isArray(points) || points.length === 0 || !Number.isFinite(absorbance)) return false;
  return absorbance < points[0].a || absorbance > points[points.length - 1].a;
}

/** อ่านไฟล์ CSV อย่างง่าย (รองรับ comma / semicolon / tab และเครื่องหมายคำพูด) */
export function parseCsv(text) {
  const clean = String(text ?? '').replace(/^\ufeff/, '');
  const delimiter = clean.includes('\t') ? '\t' : clean.includes(';') && !clean.includes(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}
