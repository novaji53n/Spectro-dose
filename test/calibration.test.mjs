import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNumber,
  detectDoseUnit,
  buildCalibrationPoints,
  doseFromPoints,
  isOutsideRange,
  parseCsv,
} from '../js/calibration.js';

/* ---------- parseNumber ---------- */

test('parseNumber: จุดทศนิยมและจุลภาค', () => {
  assert.equal(parseNumber('0.123'), 0.123);
  assert.equal(parseNumber('0,123'), 0.123);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber(' 45.6 % '), 45.6);
  assert.ok(Number.isNaN(parseNumber('abc')));
});

/* ---------- detectDoseUnit ---------- */

test('detectDoseUnit: kGy / Gy / mGy / cGy', () => {
  assert.equal(detectDoseUnit('Dose (kGy)'), 'kGy');
  assert.equal(detectDoseUnit('Dose (Gy)'), 'Gy');
  assert.equal(detectDoseUnit('dose mGy'), 'mGy');
  assert.equal(detectDoseUnit('cGy'), 'cGy');
  assert.equal(detectDoseUnit('Dose'), '');
});

/* ---------- buildCalibrationPoints: รูปแบบมาตรฐาน A/B + หัวตารางแถว 1 ---------- */

test('buildCalibrationPoints: ข้ามแถว 1 (หัวตาราง) และอ่านเฉพาะ A/B', () => {
  const rows = [
    ['A', 'Dose', 'หมายเหตุ'],
    [0.085, 2.2487, 'x'],
    [0.086, 2.307, ''],
    [0.087, 2.3653, ''],
  ];
  const result = buildCalibrationPoints(rows);
  assert.equal(result.headerRow, 0);
  assert.equal(result.points.length, 3);
  assert.deepEqual(result.points[0], { a: 0.085, dose: 2.2487 });
  assert.deepEqual(result.points[2], { a: 0.087, dose: 2.3653 });
  assert.equal(result.unit, 'kGy'); // ไม่ระบุหน่วย -> ถือว่า kGy
});

test('buildCalibrationPoints: แถว 1 ไม่ถูกนับเป็นข้อมูล แม้หัวตารางชื่ออะไรก็ตาม', () => {
  const rows = [
    ['Absorbance', 'Dose (Gy)'],
    [0.1, 10],
    [0.2, 25.5],
  ];
  const result = buildCalibrationPoints(rows);
  assert.equal(result.points.length, 2);
  assert.equal(result.unit, 'Gy');
  assert.equal(result.points[0].a, 0.1);
});

test('buildCalibrationPoints: ไม่มีหัวตาราง (แถวแรกเป็นตัวเลข) ต้องอ่านแถวแรกด้วย', () => {
  const rows = [
    [0.05, 5],
    [0.1, 12],
  ];
  const result = buildCalibrationPoints(rows);
  assert.equal(result.headerRow, -1);
  assert.equal(result.points.length, 2);
  assert.equal(result.points[1].dose, 12);
});

test('buildCalibrationPoints: คอลัมน์ C ขึ้นไปไม่ถูกใช้', () => {
  const rows = [
    ['A', 'Dose', 'อื่น ๆ'],
    [0.1, 10, 999],
    [0.2, 20, 888],
  ];
  const { points } = buildCalibrationPoints(rows);
  assert.deepEqual(points, [
    { a: 0.1, dose: 10 },
    { a: 0.2, dose: 20 },
  ]);
});

test('buildCalibrationPoints: แถวที่ข้อมูลไม่ครบถูกข้าม และเรียงตาม A', () => {
  const rows = [
    ['A', 'Dose'],
    [0.3, 30],
    ['', ''],
    [0.1, 10],
    ['x', 5],
    [0.2, 20],
  ];
  const result = buildCalibrationPoints(rows);
  assert.deepEqual(result.points.map((p) => p.a), [0.1, 0.2, 0.3]);
  assert.equal(result.skipped, 1); // แถวที่ A ไม่ใช่ตัวเลข (แถวว่างถูกตัดทิ้งก่อนแล้ว)
});

test('buildCalibrationPoints: รับค่า kGy จากหัวตารางได้', () => {
  const rows = [
    ['A', 'Dose (kGy)'],
    [0.5, 12.5],
    [0.6, 15.0],
  ];
  const { unit, points } = buildCalibrationPoints(rows);
  assert.equal(unit, 'kGy');
  assert.equal(points.length, 2);
});

/* ---------- doseFromPoints ---------- */

test('doseFromPoints: interpolate ตรงช่วง', () => {
  const points = [
    { a: 0.1, dose: 10 },
    { a: 0.2, dose: 25.5 },
    { a: 0.4, dose: 60.2 },
  ];
  const mid = doseFromPoints(0.15, points);
  assert.ok(Math.abs(mid - 17.75) < 1e-9);
  assert.equal(doseFromPoints(0.2, points), 25.5);
});

test('doseFromPoints: นอกช่วงใช้การต่อเส้นจากช่วงปลาย', () => {
  const points = [
    { a: 0.1, dose: 10 },
    { a: 0.2, dose: 20 },
  ];
  assert.ok(Math.abs(doseFromPoints(0.0, points) - 0) < 1e-9);
  assert.ok(Math.abs(doseFromPoints(0.3, points) - 30) < 1e-9);
});

test('doseFromPoints: ข้อมูลไม่พอ', () => {
  assert.equal(doseFromPoints(0.2, []), null);
  assert.equal(doseFromPoints(0.2, null), null);
  assert.equal(doseFromPoints(0.2, [{ a: 0.1, dose: 7 }]), 7);
});

test('isOutsideRange', () => {
  const points = [{ a: 0.1, dose: 1 }, { a: 0.3, dose: 3 }];
  assert.equal(isOutsideRange(0.05, points), true);
  assert.equal(isOutsideRange(0.2, points), false);
  assert.equal(isOutsideRange(0.5, points), true);
});

test('parseCsv: รองรับ comma, semicolon และเครื่องหมายคำพูด', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('"a,1",b\n'), [['a,1', 'b']]);
});
