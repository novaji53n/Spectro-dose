import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLine,
  toNumber,
  detectUnit,
  toAbsorbance,
  formatValue,
  formatDose,
} from '../js/parser.js';

/* ---------- toNumber ---------- */

test('toNumber: จุดทศนิยมปกติ', () => {
  assert.equal(toNumber('0.412'), 0.412);
  assert.equal(toNumber('-01.5'), -1.5);
  assert.equal(toNumber('+3'), 3);
});

test('toNumber: จุลภาคเป็นจุดทศนิยม', () => {
  assert.equal(toNumber('0,412'), 0.412);
});

test('toNumber: ค่าที่ใช้ไม่ได้คืน NaN', () => {
  assert.ok(Number.isNaN(toNumber('')));
  assert.ok(Number.isNaN(toNumber(null)));
  assert.ok(Number.isNaN(toNumber('abc')));
});

/* ---------- detectUnit ---------- */

test('detectUnit: เดาจากบรรทัด', () => {
  assert.equal(detectUnit('0.412 A'), 'A');
  assert.equal(detectUnit('ABS 0.412'), 'A');
  assert.equal(detectUnit('600NM 100.0 T'), '%T');
  assert.equal(detectUnit('45.6 %'), '%T');
  assert.equal(detectUnit('0.412'), 'A');
});

test('detectUnit: หน่วยที่ระบุชัดเจนชนะการเดา', () => {
  assert.equal(detectUnit('0.412 T', 'A'), 'A');
  assert.equal(detectUnit('45.6 A', 'T'), '%T');
});

/* ---------- parseLine: auto ---------- */

test('auto: ข้ามความยาวคลื่น แล้วอ่านค่าที่มีทศนิยม', () => {
  const r = parseLine('600NM 0.412 A');
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.412);
  assert.equal(r.unit, 'A');
});

test('auto: รองรับค่าติดลบ (absorbance ติดลบได้)', () => {
  const r = parseLine('574NM -01.5 A');
  assert.equal(r.ok, true);
  assert.equal(r.value, -1.5);
  assert.equal(r.unit, 'A');
});

test('auto: ข้ามวันที่และเวลา', () => {
  const r = parseLine('23/11/2026 17:11:04 0.123 A');
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.123);
});

test('auto: transmittance เป็น %T', () => {
  const r = parseLine('600NM 100.0 T');
  assert.equal(r.ok, true);
  assert.equal(r.value, 100);
  assert.equal(r.unit, '%T');
});

test('auto: บรรทัดที่เป็นค่าเดียวแบบไม่มีทศนิยม ก็ยังอ่านได้', () => {
  const r = parseLine('600NM 0 A');
  assert.equal(r.ok, true);
  assert.equal(r.value, 0);
  assert.equal(r.unit, 'A');
});

test('auto: ไม่มีตัวเลข -> ok=false พร้อมเหตุผล', () => {
  const r = parseLine('GENESYS 20 READY');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-number');
});

test('auto: บรรทัดว่าง -> empty', () => {
  const r = parseLine('   ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

/* ---------- parseLine: first / last ---------- */

test('first: ตัวเลขตัวแรก', () => {
  const r = parseLine('600NM 0.412 A', { mode: 'first' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 600);
});

test('last: ตัวเลขตัวสุดท้าย', () => {
  const r = parseLine('600NM 0.412 A', { mode: 'last' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.412);
});

/* ---------- parseLine: custom ---------- */

test('custom: named groups value/unit', () => {
  const r = parseLine('ABS=0.456', { mode: 'custom', regex: 'ABS=(?<value>[0-9.]+)' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.456);
  assert.equal(r.unit, 'A');
});

test('custom: ใช้ group 1 และ 2', () => {
  const r = parseLine('R 0.789 T', { mode: 'custom', regex: 'R\\s+([0-9.]+)\\s+(A|T)' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.789);
  assert.equal(r.unit, '%T');
});

test('custom: regex ไม่ตรง -> no-match', () => {
  const r = parseLine('0.412 A', { mode: 'custom', regex: '^X=(?<value>[0-9.]+)' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-match');
});

test('custom: regex พัง -> bad-regex', () => {
  const r = parseLine('0.412 A', { mode: 'custom', regex: '(' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-regex');
});

test('custom: ไม่ได้ระบุ regex -> bad-regex', () => {
  const r = parseLine('0.412 A', { mode: 'custom', regex: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-regex');
});

/* ---------- แปลงหน่วย ---------- */

test('toAbsorbance: %T -> A', () => {
  assert.ok(Math.abs(toAbsorbance(50, '%T') - 0.30103) < 1e-4);
  assert.equal(toAbsorbance(100, '%T'), 0);
  assert.equal(toAbsorbance(0.412, 'A'), 0.412);
  assert.equal(toAbsorbance(0, '%T'), null);
});

test('formatValue / formatDose', () => {
  assert.equal(formatValue(0.41234, 'A'), '0.412');
  assert.equal(formatValue(99.5, '%T'), '99.50');
  assert.equal(formatValue(null, 'A'), '—');
  assert.equal(formatDose(null), '—');
  assert.equal(formatDose(0.12345), '0.1235');
  assert.equal(formatDose(12.345), '12.35');
  assert.equal(formatDose(123.45), '123.5');
});

/* ---------- ตัวอย่างจริงของเครื่องสเปกโตรโฟโตมิเตอร์ ---------- */

test('ตัวอย่าง Spectronic: "574NM -01.5 A CR LF" ที่ถูกตัด CR LF แล้ว', () => {
  const r = parseLine('574NM -01.5 A');
  assert.equal(r.value, -1.5);
  assert.equal(r.unit, 'A');
});
