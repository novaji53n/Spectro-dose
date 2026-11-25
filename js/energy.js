/**
 * energy.js — คำนวณพลังงานลำอิเล็กตรอนจาก depth–dose ในอะลูมิเนียม
 * อ้างอิงโครงสร้างเดียวกับชีต "Dose Conversion" ในไฟล์ dose table ED.xlsx
 *   Response = (Ai − Ao) / t
 *   Dose     = lookup(Response) จากตาราง Dose
 *   fit      = linear regression ของ Dose(adjusted) กับ Depth ในช่วงที่เลือก
 *   R50      = (Dmax/2 − intercept) / slope
 *   Rp       = −intercept / slope
 *   Ea       = 0.99 × 6.2 × R50        (MeV)
 *   Ep       = 0.99 × 5.09 × Rp + 0.2  (MeV)
 */
import { parseNumber, doseFromPoints } from './calibration.js';

/** ระยะลึกในอะลูมิเนียม 60 ระดับ (cm) ตามไฟล์ dose table ED.xlsx */
export const STANDARD_DEPTHS = [
  0.1812, 0.2701, 0.364, 0.4501, 0.5376, 0.6272, 0.7133, 0.7987, 0.8911, 0.9794,
  1.0697, 1.1509, 1.2377, 1.3266, 1.4148, 1.4988, 1.5857, 1.6767, 1.7572, 1.858,
  1.942, 2.0225, 2.1157, 2.2053, 2.2879, 2.3733, 2.4664, 2.5504, 2.6379, 2.722,
  3.1225, 3.2115, 3.3053, 3.3914, 3.4789, 3.5685, 3.6546, 3.74, 3.8325, 3.9207,
  4.011, 4.0922, 4.179, 4.2679, 4.3562, 4.4402, 4.527, 4.618, 4.6985, 4.7993,
  4.8833, 4.9639, 5.057, 5.1466, 5.2292, 5.3146, 5.4077, 5.4917, 5.5793, 5.6633,
];

/** สร้างแถวเริ่มต้น 60 แถว พร้อมระยะลึกมาตรฐาน (ยังไม่มีค่า Ai) */
export function createStandardRows() {
  return STANDARD_DEPTHS.map((depth) => ({ depth, ai: null }));
}

const ENERGY_UNIT_PATTERNS = [
  [/kgy/i, 'kGy'],
  [/mgy/i, 'mGy'],
  [/cgy/i, 'cGy'],
  [/(?<!k)(?<!m)(?<!c)gy/i, 'Gy'],
];

function detectUnit(text) {
  const value = String(text ?? '');
  for (const [pattern, unit] of ENERGY_UNIT_PATTERNS) if (pattern.test(value)) return unit;
  return 'kGy';
}

/**
 * อ่านตาราง Dose (Response → Dose) จากชีตแรกของไฟล์ Excel
 * หาคอลัมน์จากหัวตารางที่มีคำว่า Response และ Dose
 * ถ้าไม่พบหัวตาราง จะถือว่าเป็น 2 คอลัมน์ (response, dose)
 */
export function buildResponseDosePoints(rows) {
  const data = (rows || []).filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''));
  if (data.length === 0) return { points: [], unit: 'kGy', headerRow: -1, skipped: 0 };

  let headerRow = -1;
  let rCol = -1;
  let dCol = -1;
  let unit = '';

  const limit = Math.min(data.length, 25);
  for (let r = 0; r < limit; r += 1) {
    let foundR = -1;
    let foundD = -1;
    data[r].forEach((cell, index) => {
      const text = String(cell ?? '').trim();
      if (!text) return;
      if (foundR < 0 && /response/i.test(text) && !/minimum|maximum/i.test(text)) foundR = index;
      if (foundD < 0 && /dose/i.test(text) && !/minimum|maximum/i.test(text)) foundD = index;
    });
    if (foundR >= 0 && foundD >= 0 && foundR !== foundD) {
      headerRow = r;
      rCol = foundR;
      dCol = foundD;
      unit = detectUnit(data[r][dCol]);
      break;
    }
  }

  const start = headerRow >= 0 ? headerRow + 1 : 0;
  if (rCol < 0) rCol = 0;
  if (dCol < 0) dCol = 1;
  if (!unit) unit = 'kGy';

  const points = [];
  let skipped = 0;
  for (let r = start; r < data.length; r += 1) {
    const response = parseNumber(data[r][rCol]);
    const dose = parseNumber(data[r][dCol]);
    if (!Number.isFinite(response) || !Number.isFinite(dose)) {
      skipped += 1;
      continue;
    }
    points.push({ a: response, dose });
  }

  points.sort((p1, p2) => p1.a - p2.a);
  return { points, unit, headerRow, skipped };
}

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sx += point.x;
    sy += point.y;
    sxx += point.x * point.x;
    sxy += point.x * point.y;
  }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, n };
}

function rSquared(points, fit) {
  const n = points.length;
  if (n < 2) return 0;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const point of points) {
    const predicted = fit.slope * point.x + fit.intercept;
    ssRes += (point.y - predicted) ** 2;
    ssTot += (point.y - meanY) ** 2;
  }
  if (ssTot === 0) return 0;
  return 1 - ssRes / ssTot;
}

const MIN_FIT_POINTS = 5;
const MAX_FIT_POINTS = 14;
const R2_GOOD_ENOUGH = 0.999;

/**
 * เลือกช่วง fit อัตโนมัติ:
 * - ไล่หน้าต่าง 5–14 จุดหลัง Dmax แล้วหา R² ที่ดีที่สุดของแต่ละขนาด
 * - ถ้ามีขนาดที่ R² ≥ 0.999 ให้ใช้หน้าต่างที่ "ใหญ่ที่สุด" (จุดมากที่สุด) เพื่อความเสถียร
 * - ถ้าไม่มี ให้ใช้ R² สูงสุดตามเดิม
 */
export function autoFitRange(rows, dmax, criterion = 'r2') {
  const valid = rows.filter((row) => row.adjusted !== null && row.depth !== null && row.adjusted !== undefined);
  if (valid.length < MIN_FIT_POINTS + 1 || !Number.isFinite(dmax) || dmax <= 0) return null;

  let maxIndex = 0;
  valid.forEach((row, index) => {
    if (row.adjusted > valid[maxIndex].adjusted) maxIndex = index;
  });

  const tail = valid.slice(maxIndex + 1);
  if (tail.length < MIN_FIT_POINTS) return null;

  const perSize = [];
  for (let size = Math.min(MAX_FIT_POINTS, tail.length); size >= MIN_FIT_POINTS; size -= 1) {
    let best = null;
    for (let start = 0; start + size <= tail.length; start += 1) {
      const window = tail.slice(start, start + size);
      const points = window.map((row) => ({ x: row.depth, y: row.adjusted }));
      const fit = linearFit(points);
      if (!fit || !(fit.slope < 0)) continue;
      const r2 = rSquared(points, fit);
      if (!best || r2 > best.r2 + 1e-12) {
        best = {
          from: window[0].index,
          to: window[window.length - 1].index,
          fit,
          r2,
          points: size,
        };
      }
    }
    if (best) perSize.push(best);
  }

  if (perSize.length === 0) return null;

  let best = perSize.reduce((a, b) => (b.r2 > a.r2 ? b : a));

  if (criterion === 'slope1') {
    for (const candidate of perSize) {
      const distance = Math.abs(Math.abs(candidate.fit.slope) - 1);
      const bestDistance = Math.abs(Math.abs(best.fit.slope) - 1);
      if (distance < bestDistance - 1e-12 || (Math.abs(distance - bestDistance) < 1e-12 && candidate.r2 > best.r2)) {
        best = candidate;
      }
    }
  } else {
    const good = perSize
      .filter((candidate) => candidate.r2 >= R2_GOOD_ENOUGH)
      .sort((a, b) => b.points - a.points || b.r2 - a.r2);
    if (good.length > 0) best = good[0];
  }

  return { from: best.from, to: best.to, r2: best.r2, slope: best.fit.slope, criterion, points: best.points };
}

/**
 * @param {object} params
 * @param {{depth:number|string|null, ai:number|string|null}[]} params.rows
 * @param {number} params.ao
 * @param {number} params.thickness
 * @param {number} params.correction
 * @param {{a:number,dose:number}[]} params.table
 * @param {boolean} params.autoFit
 * @param {number} params.fitFrom
 * @param {number} params.fitTo
 */
/** กลับตาราง Dose: dose → response (interpolate) */
export function doseToResponse(dose, table) {
  if (!Array.isArray(table) || table.length === 0) return null;
  const first = table[0];
  const last = table[table.length - 1];
  if (dose <= first.dose) return first.a;
  if (dose >= last.dose) return last.a;

  for (let i = 1; i < table.length; i += 1) {
    if (dose <= table[i].dose) {
      const p0 = table[i - 1];
      const p1 = table[i];
      const span = p1.dose - p0.dose;
      const t = span === 0 ? 0 : (dose - p0.dose) / span;
      return p0.a + t * (p1.a - p0.a);
    }
  }
  return last.a;
}

function buildEnergyCurve(energy, rpRatio = 1.335) {
  const e = Number(energy);
  if (!Number.isFinite(e) || e <= 0.5) throw new Error('พลังงานต้องมากกว่า 0.5 MeV');

  const r50 = e / (0.99 * 6.2);
  // ใช้สัดส่วน Rp/R50 แบบเดียวกับไฟล์ตัวอย่าง energy test.xlsx (Rp 4.176 / R50 3.128)
  const rp = r50 * (Number(rpRatio) > 1 ? Number(rpRatio) : 1.335);
  if (!(rp > r50 + 1e-6)) throw new Error('พลังงานต่ำเกินไปสำหรับสูตรนี้');

  const slope = -0.5 / (rp - r50);
  const intercept = -slope * rp;
  const zmax = rp + 1 / slope;
  return { e, r50, rp, slope, intercept, zmax };
}

function relativeDoseAt(curve, depth, index) {
  let relative;
  if (depth <= curve.zmax) {
    const t = curve.zmax > 0 ? depth / curve.zmax : 1;
    relative = 0.85 + 0.15 * t * t; // buildup จาก surface dose 85% ไปถึง 100% ที่ zmax
  } else {
    relative = 1 + curve.slope * (depth - curve.zmax); // ส่วนลดลงแบบเส้นตรง (tangent)
  }
  if (relative < 0.01) relative = 0.01;

  const ripple = 1 + 0.002 * Math.sin(index * 1.7); // ripple เล็กน้อยให้เหมือนข้อมูลวัดจริง
  return Math.max(0, relative * ripple);
}

/**
 * จำลอง depth–dose แบบเปอร์เซ็นต์ depth dose (PDD) ของลำอิเล็กตรอน
 * แล้วแปลงกลับเป็นค่า Ai ผ่านตาราง Dose (Response → Dose)
 */
export function simulateDepthDose({ energy, depths, table, ao = 0, thickness = 0.018, peakDose = 31 }) {
  if (!Array.isArray(table) || table.length < 2) throw new Error('ต้องมีตาราง Dose (Response → Dose) ก่อน');
  if (!Array.isArray(depths) || depths.length === 0) throw new Error('ไม่มีระยะลึกให้จำลอง');

  const curve = buildEnergyCurve(energy);
  const maxTableDose = table.reduce((max, point) => (point.dose > max ? point.dose : max), 0);

  // ใช้ Dmax ที่สมจริง (ค่าเริ่มต้น 31 kGy) แต่ไม่เกินขอบเขตตารางสอบเทียบ
  const requested = Number(peakDose) > 0 ? Number(peakDose) : 31;
  const peak = Math.min(requested, maxTableDose * 0.98);

  const rows = depths.map((rawDepth, index) => {
    const depth = Number(rawDepth);
    const dose = relativeDoseAt(curve, depth, index) * peak;
    const response = doseToResponse(dose, table);
    const ai = response === null ? null : Number((response * thickness + ao).toFixed(4));
    return { depth: Number.isFinite(depth) ? depth : null, ai };
  });

  return { rows, ...curve, peakDose: peak };
}

/**
 * จำลองเส้น depth–dose แล้วคืน "ค่าโดส" โดยตรง (ใช้กับโหมดกรอกโดส)
 * ค่าที่ได้มีรูปทรงเหมือนตัวอย่าง Excel: ขึ้นถึง Dmax แล้วลดลงตาม tangent
 */
export function simulateDoseCurve({ energy, depths, peakDose = 31 }) {
  if (!Array.isArray(depths) || depths.length === 0) throw new Error('ไม่มีระยะลึกให้จำลอง');

  const curve = buildEnergyCurve(energy);
  const peak = Number(peakDose) > 0 ? Number(peakDose) : 31;

  const raw = depths.map((rawDepth, index) => {
    const depth = Number(rawDepth);
    return { depth: Number.isFinite(depth) ? depth : null, dose: relativeDoseAt(curve, depth, index) * peak };
  });

  // ปรับสเกลให้ค่าสูงสุดที่สุ่มได้ = peakDose (Dmax ตรงกับที่ตั้งไว้)
  const maxRaw = raw.reduce((max, row) => (row.dose > max ? row.dose : max), 0);
  const scale = maxRaw > 0 ? peak / maxRaw : 1;

  const rows = raw.map((row) => ({
    depth: row.depth,
    dose: Number((row.dose * scale).toFixed(3)),
    ai: null,
  }));

  return { rows, ...curve, peakDose: peak };
}

export function computeEnergy({ rows = [], ao = 0, thickness = 0.018, correction = 1, table = [], autoFit = true, fitFrom = 1, fitTo = 1, criterion = 'r2' }) {
  const prepared = rows.map((row, index) => {
    const depth = row && row.depth !== null && row.depth !== '' ? Number(row.depth) : NaN;
    const ai = row && row.ai !== null && row.ai !== '' ? Number(row.ai) : NaN;
    const directDose = row && row.dose !== null && row.dose !== undefined && row.dose !== '' ? Number(row.dose) : NaN;

    let response = null;
    let dose = null;
    let adjusted = null;

    if (Number.isFinite(directDose)) {
      // กรอกโดสโดยตรง (kGy) ไม่ต้องผ่านตารางสอบเทียบ
      dose = directDose;
      adjusted = dose * correction;
    } else if (Number.isFinite(ai) && thickness > 0) {
      response = (ai - ao) / thickness;
      if (table.length > 0) {
        dose = doseFromPoints(response, table);
        if (dose !== null) adjusted = dose * correction;
      }
    }

    return {
      index: index + 1,
      depth: Number.isFinite(depth) ? depth : null,
      ai: Number.isFinite(ai) ? ai : null,
      response,
      dose,
      adjusted,
      direct: Number.isFinite(directDose),
    };
  });

  const withDose = prepared.filter((row) => row.adjusted !== null && row.depth !== null);
  const dmax = withDose.length > 0 ? Math.max(...withDose.map((row) => row.adjusted)) : null;

  let range = null;
  if (autoFit) {
    range = autoFitRange(prepared, dmax, criterion);
  } else {
    range = { from: Number(fitFrom) || 1, to: Number(fitTo) || 1 };
  }

  const fitRows = range
    ? prepared.filter(
        (row) =>
          row.index >= range.from &&
          row.index <= range.to &&
          row.depth !== null &&
          row.adjusted !== null,
      )
    : [];

  const fit = linearFit(fitRows.map((row) => ({ x: row.depth, y: row.adjusted })));
  const r2 = fit ? rSquared(fitRows.map((row) => ({ x: row.depth, y: row.adjusted })), fit) : null;

  let r50 = null;
  let rp = null;
  let ea = null;
  let ep = null;
  let error = '';
  let warning = '';

  const hasDirectDose = prepared.some((row) => row.direct);

  if (table.length === 0 && !hasDirectDose) {
    error = 'ยังไม่มีตารางสอบเทียบ (A → Dose) — นำเข้าที่แท็บสอบเทียบก่อน';
  } else if (dmax === null) {
    error = 'ยังไม่มีข้อมูลที่คำนวณโดสได้';
  } else if (!range) {
    error = 'จุดหลัง Dmax ไม่พอสำหรับลากเส้น tangent (ต้องมีอย่างน้อย 5 จุด)';
  } else if (!fit) {
    error = 'จำนวนจุดในช่วง fit ไม่พอ';
  } else if (!(fit.slope < 0)) {
    error = 'ความชันไม่ติดลบ — ช่วง fit ไม่เหมาะสม';
  } else if (fitRows.length < MIN_FIT_POINTS) {
    warning = `ช่วง fit มีเพียง ${fitRows.length} จุด (แนะนำอย่างน้อย ${MIN_FIT_POINTS} จุด)`;
  }

  if (!error) {
    r50 = (dmax / 2 - fit.intercept) / fit.slope;
    rp = -fit.intercept / fit.slope;
    ea = 0.99 * 6.2 * r50;
    ep = 0.99 * 5.09 * rp + 0.2;

    if (r2 !== null && r2 < 0.98) {
      warning = warning ? `${warning} · R² ต่ำ (${r2.toFixed(4)})` : `R² ต่ำ (${r2.toFixed(4)}) — ควรเลือกช่วงที่ตรงกว่า`;
    }
  }

  return {
    rows: prepared,
    dmax,
    range,
    fit,
    r2,
    r50,
    rp,
    ea,
    ep,
    error,
    warning,
  };
}
