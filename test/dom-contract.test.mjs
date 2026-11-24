import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

test('ทุก id ที่ app.js เรียกใช้ มีอยู่จริงใน index.html', () => {
  const missing = [...used].filter((id) => !ids.has(id)).sort();
  assert.deepEqual(missing, []);
});

test('ไฟล์ที่ index.html อ้างถึง มีอยู่จริงในโปรเจกต์', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => !url.startsWith('data:') && !url.startsWith('http'));
  const missing = refs.filter((url) => !existsSync(path.join(ROOT, url)));
  assert.deepEqual(missing, []);
});
