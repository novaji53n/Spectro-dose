import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResponseDosePoints,
  computeEnergy,
  autoFitRange,
  STANDARD_DEPTHS,
  createStandardRows,
  simulateDepthDose,
  simulateDoseCurve,
  doseToResponse,
} from '../js/energy.js';

test('STANDARD_DEPTHS: 60 ระดับ 0.1812–5.6633 cm', () => {
  assert.equal(STANDARD_DEPTHS.length, 60);
  assert.equal(STANDARD_DEPTHS[0], 0.1812);
  assert.equal(STANDARD_DEPTHS[59], 5.6633);
  const rows = createStandardRows();
  assert.equal(rows.length, 60);
  assert.equal(rows[0].depth, 0.1812);
  assert.equal(rows[59].depth, 5.6633);
  assert.equal(rows[0].ai, null);
});

/* ---------- buildResponseDosePoints ---------- */

test('buildResponseDosePoints: หา Response / Estimated Dose จากหัวตาราง (แบบไฟล์ ED)', () => {
  const rows = [
    ['Calibration Curve ID#', ': 8932-ED-7103'],
    ['Average Original Absorbance', 'Average Thickness', null, 'Minimum Response', 'Maximum Response', 'Batch ID'],
    [0, 0.018, null, 4.35754189944134, 61.2290502793296, 'ED'],
    ['Irradiated Absorbance', 'Response (Ai-Ao)/t', null, null, 'Estimated Dose (kGy)'],
    [0.041, 2.277777777777778, null, null, 0.00000000000005],
    [0.085, 4.5, null, null, 2.27259065714404],
  ];
  const result = buildResponseDosePoints(rows);
  assert.equal(result.headerRow, 3);
  assert.equal(result.points.length, 2);
  assert.equal(result.unit, 'kGy');
  assert.deepEqual(result.points[0], { a: 2.277777777777778, dose: 0.00000000000005 });
  assert.deepEqual(result.points[1], { a: 4.5, dose: 2.27259065714404 });
});

test('buildResponseDosePoints: ระบุหน่วย Gy ได้', () => {
  const rows = [
    ['Response', 'Estimated Dose (Gy)'],
    [1, 10],
    [2, 20],
  ];
  const result = buildResponseDosePoints(rows);
  assert.equal(result.unit, 'Gy');
  assert.equal(result.points.length, 2);
});

test('buildResponseDosePoints: ไฟล์ 2 คอลัมน์ไม่มีหัวตาราง', () => {
  const rows = [
    [2.5, 1.2],
    [3.0, 1.8],
  ];
  const result = buildResponseDosePoints(rows);
  assert.equal(result.headerRow, -1);
  assert.equal(result.points.length, 2);
});

/* ---------- computeEnergy ---------- */

function makeRows() {
  // depth (cm) และ Ai ที่ให้ dose ลดลงเชิงเส้น 9 → 1
  const depths = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];
  const doses = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  return depths.map((depth, i) => ({ depth, ai: doses[i] + 1 }));
}

test('computeEnergy: สูตร R50 / Rp / Ea / Ep ตรงกับ Excel', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 10, dose: 9 },
  ];
  const result = computeEnergy({
    rows: makeRows(),
    ao: 0,
    thickness: 1,
    correction: 1,
    table,
    autoFit: true,
  });

  assert.equal(result.error, '');
  assert.equal(result.dmax, 9);
  assert.ok(Math.abs(result.fit.slope + 10) < 1e-9);
  assert.ok(Math.abs(result.fit.intercept - 14) < 1e-9);
  assert.ok(Math.abs(result.r50 - 0.95) < 1e-9);
  assert.ok(Math.abs(result.rp - 1.4) < 1e-9);
  assert.ok(Math.abs(result.ea - 0.99 * 6.2 * 0.95) < 1e-9);
  assert.ok(Math.abs(result.ep - (0.99 * 5.09 * 1.4 + 0.2)) < 1e-9);
});

test('computeEnergy: correction factor คูณเข้าไปในโดส', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 10, dose: 9 },
  ];
  const base = computeEnergy({ rows: makeRows(), thickness: 1, table, autoFit: true });
  const doubled = computeEnergy({ rows: makeRows(), thickness: 1, table, autoFit: true, correction: 2 });

  assert.ok(Math.abs(doubled.dmax - base.dmax * 2) < 1e-9);
  // R50/Rp ขึ้นกับรูปทรง ไม่เปลี่ยนเมื่อคูณค่าคงที่ทั้งชุด
  assert.ok(Math.abs(doubled.r50 - base.r50) < 1e-9);
  assert.ok(Math.abs(doubled.rp - base.rp) < 1e-9);
});

test('computeEnergy: ใช้ช่วง fit แบบกำหนดเองได้', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 10, dose: 9 },
  ];
  const result = computeEnergy({
    rows: makeRows(),
    thickness: 1,
    table,
    autoFit: false,
    fitFrom: 2,
    fitTo: 9,
  });
  assert.equal(result.range.from, 2);
  assert.equal(result.range.to, 9);
  assert.equal(result.fit.n, 8);
  assert.ok(Math.abs(result.r50 - 0.95) < 1e-9);
});

test('computeEnergy: ไม่มีตาราง Dose -> แจ้งเตือน', () => {
  const result = computeEnergy({ rows: makeRows(), thickness: 1, table: [] });
  assert.match(result.error, /ตารางสอบเทียบ/);
  assert.equal(result.ea, null);
});

test('computeEnergy: ข้อมูลเพิ่มขึ้นตามความลึก (slope บวก) -> แจ้งเตือน', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 10, dose: 9 },
  ];
  const rows = [0.5, 0.6, 0.7, 0.8, 0.9].map((depth, i) => ({ depth, ai: 2 + i }));
  const result = computeEnergy({ rows, thickness: 1, table, autoFit: true });
  assert.notEqual(result.error, '');
});

test('computeEnergy: response ใช้ (Ai − Ao)/t ถูกต้อง', () => {
  const table = [{ a: 0, dose: 0 }, { a: 100, dose: 100 }];
  const result = computeEnergy({
    rows: [{ depth: 1, ai: 0.05 }],
    ao: 0.01,
    thickness: 0.02,
    table,
  });
  // response = (0.05 - 0.01)/0.02 = 2 -> dose = 2
  assert.ok(Math.abs(result.rows[0].response - 2) < 1e-12);
  assert.ok(Math.abs(result.rows[0].dose - 2) < 1e-12);
});

test('doseToResponse: กลับตารางได้', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 3, dose: 10 },
    { a: 5, dose: 20 },
  ];
  assert.equal(doseToResponse(0, table), 1);
  assert.equal(doseToResponse(10, table), 3);
  assert.ok(Math.abs(doseToResponse(15, table) - 4) < 1e-9);
  assert.equal(doseToResponse(99, table), 5);
});

test('simulateDepthDose: จำลองแล้วคำนวณพลังงานกลับได้ใกล้เคียงค่าที่ป้อน', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 120, dose: 150 },
  ];

  for (const energy of [6, 8, 10, 12]) {
    const simulation = simulateDepthDose({
      energy,
      depths: STANDARD_DEPTHS,
      table,
      ao: 0,
      thickness: 0.018,
    });

    assert.equal(simulation.rows.length, 60);
    assert.ok(simulation.rows.every((row) => Number.isFinite(row.ai)));

    const result = computeEnergy({
      rows: simulation.rows,
      ao: 0,
      thickness: 0.018,
      correction: 1,
      table,
      autoFit: true,
      criterion: 'r2',
    });

    assert.equal(result.error, '', `energy ${energy}: ${result.error}`);
    const eaError = Math.abs(result.ea - energy);
    assert.ok(eaError < 0.8, `Ea ${result.ea.toFixed(2)} vs ${energy} (err ${eaError.toFixed(2)})`);
    assert.ok(result.ep > 0);
    assert.ok(result.r2 > 0.9, `R² ${result.r2}`);
  }
});

test('simulateDoseCurve: จำลองโดสแล้วคำนวณพลังงานกลับได้ใกล้ค่าที่ป้อน', () => {
  for (const energy of [10, 19.2]) {
    const simulation = simulateDoseCurve({ energy, depths: STANDARD_DEPTHS, peakDose: 31 });
    assert.equal(simulation.rows.length, 60);
    assert.ok(simulation.rows.every((row) => Number.isFinite(row.dose)));

    const result = computeEnergy({ rows: simulation.rows, table: [], autoFit: true });
    assert.equal(result.error, '', `energy ${energy}: ${result.error}`);
    const error = Math.abs(result.ea - energy);
    assert.ok(error < 0.8, `Ea ${result.ea.toFixed(2)} vs ${energy} (err ${error.toFixed(2)})`);
    assert.ok(result.ep > 0);
  }
});

test('simulateDepthDose: รูปทรง PDD (ขึ้นถึงยอดแล้วลดลง)', () => {
  const table = [
    { a: 1, dose: 0 },
    { a: 120, dose: 150 },
  ];
  const simulation = simulateDepthDose({ energy: 10, depths: STANDARD_DEPTHS, table, ao: 0, thickness: 0.018 });
  const values = simulation.rows.map((row) => row.ai);
  const peakIndex = values.indexOf(Math.max(...values));

  assert.ok(peakIndex > 0, 'ยอดต้องไม่อยู่แถวแรก');
  assert.ok(peakIndex < values.length - 1, 'ยอดต้องไม่อยู่แถวสุดท้าย');
  assert.ok(values[0] < values[peakIndex], 'ผิวหน้าต้องน้อยกว่ายอด');
  assert.ok(values[values.length - 1] < values[peakIndex] * 0.2, 'ปลายต้องลดลงมาก');
});

test('computeEnergy: ตรงกับไฟล์ตัวอย่าง energy test.xlsx (fit แถว 27–40)', () => {
  // ค่า Dose (adjusted) จากชีต Dose Conversion ของไฟล์ตัวอย่าง
  const data = [
    [1.6766778353449701, 31.064736163036699], // Dmax (ID 18)
    [2.46641199044715, 25.539214234061699],
    [2.5504262622665301, 24.029456222408498],
    [2.6379411287450498, 22.761196282872799],
    [2.7219554005644402, 21.506289421283199],
    [3.1225437969599898, 15.6982055956025],
    [3.2114589013021702, 14.443441783720001],
    [3.3052748381671502, 12.9949798712023],
    [3.3913894667820101, 11.359264603110001],
    [3.4789043332605298, 10.3472657091105],
    [3.56851955653454, 8.8104724421207603],
    [3.6546341851494102, 7.3569137748978397],
    [3.7400486948324398, 6.3747854225055898],
    [3.8324643938337601, 5.2702372579590797],
    [3.9206793792441101, 4.1745435095559804],
  ];

  const rows = data.map(([depth, dose]) => ({ depth, ai: dose }));
  const table = [
    { a: 0, dose: 0 },
    { a: 1000, dose: 1000 },
  ];

  const result = computeEnergy({
    rows,
    ao: 0,
    thickness: 1,
    correction: 1,
    table,
    autoFit: false,
    fitFrom: 2,
    fitTo: 15,
  });

  assert.equal(result.error, '');
  assert.ok(Math.abs(result.fit.slope - -14.822095469573899) < 1e-9);
  assert.ok(Math.abs(result.fit.intercept - 61.899509471652607) < 1e-9);
  assert.ok(Math.abs(result.r50 - 3.1282446861386468) < 1e-9);
  assert.ok(Math.abs(result.rp - 4.1761645375120553) < 1e-9);
  assert.ok(Math.abs(result.ea - 19.201165883519014) < 1e-9);
  assert.ok(Math.abs(result.ep - 21.24411072097694) < 1e-9);
});

test('computeEnergy: กรอกโดสโดยตรง (ไม่ต้องมีตารางสอบเทียบ)', () => {
  const data = [
    [1.6766778353449701, 31.064736163036699],
    [2.46641199044715, 25.539214234061699],
    [2.5504262622665301, 24.029456222408498],
    [2.6379411287450498, 22.761196282872799],
    [2.7219554005644402, 21.506289421283199],
    [3.1225437969599898, 15.6982055956025],
    [3.2114589013021702, 14.443441783720001],
    [3.3052748381671502, 12.9949798712023],
    [3.3913894667820101, 11.359264603110001],
    [3.4789043332605298, 10.3472657091105],
    [3.56851955653454, 8.8104724421207603],
    [3.6546341851494102, 7.3569137748978397],
    [3.7400486948324398, 6.3747854225055898],
    [3.8324643938337601, 5.2702372579590797],
    [3.9206793792441101, 4.1745435095559804],
  ];

  const rows = data.map(([depth, dose]) => ({ depth, dose }));
  const result = computeEnergy({
    rows,
    table: [],
    autoFit: false,
    fitFrom: 2,
    fitTo: 15,
    correction: 1,
  });

  assert.equal(result.error, '');
  assert.ok(Math.abs(result.ea - 19.201165883519014) < 1e-9);
  assert.ok(Math.abs(result.ep - 21.24411072097694) < 1e-9);
});

test('autoFitRange: ต้องมีจุดหลังยอดพอ', () => {
  const rows = [
    { index: 1, adjusted: 10, depth: 0.1 },
    { index: 2, adjusted: 5, depth: 0.2 },
  ];
  assert.equal(autoFitRange(rows, 10), null);
});

test('autoFitRange: เกณฑ์ slope1 เลือกช่วงที่ |slope| ใกล้ 1 และ r2 เลือกช่วงเส้นตรงที่สุด', () => {
  const rows = [{ index: 1, adjusted: 100, depth: 0 }];

  // ช่วง slope ≈ -1 แต่มี noise
  const noisy = [-0.5, -2.0, -0.2, -1.8, -0.8, -1.2, -1.0];
  noisy.forEach((offset, i) => {
    rows.push({ index: 2 + i, adjusted: 100 - (i + 1) + offset, depth: i + 1 });
  });

  // ช่วง slope = -10 เป๊ะ (R² = 1)
  for (let i = 0; i < 7; i += 1) {
    rows.push({ index: 9 + i, adjusted: 90 - 10 * i, depth: 10 + i });
  }

  const bySlope = autoFitRange(rows, 100, 'slope1');
  const byR2 = autoFitRange(rows, 100, 'r2');

  assert.ok(bySlope, 'ต้องเลือกช่วงได้');
  assert.ok(byR2, 'ต้องเลือกช่วงได้');
  assert.ok(Math.abs(Math.abs(bySlope.slope) - 1) < Math.abs(Math.abs(byR2.slope) - 1));
  assert.ok(byR2.r2 > bySlope.r2);
  assert.ok(byR2.from >= 9, 'ช่วง R² สูงสุดควรเป็นช่วงเส้นตรงท้าย');
});
