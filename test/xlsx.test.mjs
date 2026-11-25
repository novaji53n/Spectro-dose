import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildXlsx, readXlsx } from '../js/xlsx.js';
import { buildCalibrationPoints } from '../js/calibration.js';
import { buildEnergyFormWorkbook } from '../js/report.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('buildXlsx -> readXlsx: ไป-กลับได้ครบ (ไทย + ตัวเลข)', async () => {
  const sheets = [
    { name: 'Readings', rows: [['ลำดับ', 'ค่า', 'หมายเหตุ'], [1, 0.412, 'ตัวอย่าง'], [2, 0.418, '']] },
    { name: 'Info', rows: [['เครื่อง', 'Genesys 20']] },
  ];
  const bytes = buildXlsx(sheets);
  assert.equal(bytes[0], 0x50); // P
  assert.equal(bytes[1], 0x4b); // K

  const { sheets: out } = await readXlsx(bytes);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Readings');
  assert.deepEqual(out[0].rows[0], ['ลำดับ', 'ค่า', 'หมายเหตุ']);
  assert.equal(out[0].rows[1][0], '1');
  assert.equal(Number(out[0].rows[1][1]), 0.412);
  assert.equal(out[0].rows[1][2], 'ตัวอย่าง');
  assert.equal(out[1].rows[0][1], 'Genesys 20');
});

test('buildXlsx: ฝังรูปภาพ (drawing + media) ได้', async () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sheets = [
    { name: 'Energy', rows: [['รายการ', 'ค่า'], ['Ea (MeV)', 10.03]], images: [{ data: png, width: 900, height: 280, fromCol: 5, fromRow: 1 }] },
    { name: 'Info', rows: [['เครื่อง', 'Genesys 20']] },
  ];

  const bytes = buildXlsx(sheets);
  const asText = Buffer.from(bytes).toString('latin1');

  assert.ok(asText.includes('xl/drawings/drawing1.xml'), 'ต้องมี drawing1.xml');
  assert.ok(asText.includes('xl/media/image1.png'), 'ต้องมี media image');
  assert.ok(asText.includes('xl/worksheets/_rels/sheet1.xml.rels'), 'ต้องมี sheet rels');
  assert.ok(asText.includes('<drawing r:id="rId1"/>'), 'sheet ต้องอ้าง drawing');

  const { sheets: out } = await readXlsx(bytes);
  assert.equal(out[0].name, 'Energy');
  assert.equal(out[0].rows[1][1], '10.03');
});

test('buildEnergyFormWorkbook: ฟอร์ม Dose Conversion มีสูตร VLOOKUP/SLOPE และชีต Dose Table', async () => {
  const sheets = buildEnergyFormWorkbook({
    depths: [0.1812, 0.2701],
    ais: [0.407, 0.416],
    unit: 'kGy',
    table: [
      { a: 0.4, dose: 24.7 },
      { a: 0.42, dose: 25.4 },
    ],
    fitFrom: 1,
    fitTo: 2,
  });

  assert.equal(sheets[0].name, 'Dose Conversion');
  assert.equal(sheets[1].name, 'Dose Table');

  // โครงเดียวกับ energy test.xlsx
  assert.equal(sheets[0].rows[0][0], 'DOSE CONVERSION SHEET — ENERGY');
  assert.equal(sheets[0].rows[1][1], 'Correction Factor:');
  assert.equal(sheets[0].rows[7][0], 'Dosimeter ID');
  assert.equal(sheets[0].rows[8][0], '← Enter Ai values in column C');
  assert.equal(sheets[0].rows[9][0], 1);
  assert.equal(sheets[0].rows[9][1], 0.1812);

  const flat = JSON.stringify(sheets[0].rows);
  assert.ok(flat.includes('VLOOKUP'), 'ต้องมีสูตร VLOOKUP');
  assert.ok(flat.includes('SLOPE'), 'ต้องมีสูตร SLOPE');
  assert.ok(flat.includes('INTERCEPT'), 'ต้องมีสูตร INTERCEPT');
  assert.ok(flat.includes('0.99*6.2'), 'ต้องมีสูตร Ea');
  assert.ok(flat.includes('5.09'), 'ต้องมีสูตร Ep');

  const bytes = buildXlsx(sheets);
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.includes('VLOOKUP'), 'ไฟล์ต้องมีสูตร VLOOKUP');

  const { sheets: out } = await readXlsx(bytes);
  assert.equal(out[1].name, 'Dose Table');
  assert.equal(out[1].rows.length, 3);
});

test('readXlsx: อ่านไฟล์ที่สร้างจาก Excel จริง (deflate) ได้', async () => {
  const buffer = await readFile(path.join(ROOT, 'fixtures', 'calibration.xlsx'));
  const { sheets } = await readXlsx(buffer);

  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Cal');
  assert.deepEqual(sheets[0].rows[0], ['Absorbance', 'Dose (Gy)']);

  const { points, skipped } = buildCalibrationPoints(sheets[0].rows);
  assert.equal(points.length, 4);
  assert.equal(skipped, 0);
  assert.deepEqual(points[0], { a: 0.1, dose: 10 });
  assert.deepEqual(points[3], { a: 0.4, dose: 60.2 });
});

test('readXlsx: ไฟล์ที่ไม่ใช่ xlsx ต้องโยน error', async () => {
  await assert.rejects(() => readXlsx(new Uint8Array([1, 2, 3, 4])));
});
