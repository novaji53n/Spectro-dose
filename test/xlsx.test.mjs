import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildXlsx, readXlsx } from '../js/xlsx.js';
import { buildCalibrationPoints } from '../js/calibration.js';

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
