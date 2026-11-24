/**
 * สร้างไฟล์ HTML แบบไฟล์เดียว (standalone) จากซอร์สที่แยกเป็นโมดูล
 * ใช้เมื่อต้องการแจก/เปิดด้วยการดับเบิลคลิก โดยไม่ต้องรัน localhost
 *
 *   node build-standalone.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

const MODULES = [
  'js/parser.js',
  'js/chart.js',
  'js/serial.js',
  'js/xlsx.js',
  'js/calibration.js',
  'js/energy.js',
  'js/report.js',
  'js/app.js',
];

function stripModuleSyntax(source, name) {
  const code = source
    .replace(/^\s*import\s[^;\n]*;\s*$/gm, '')
    .replace(/^\s*export\s+/gm, '');
  return `/* ===== ${name} ===== */\n${code.trim()}\n`;
}

const bundle = MODULES.map((file) => stripModuleSyntax(readFileSync(path.join(ROOT, file), 'utf8'), file)).join('\n');

const output = html
  .replace(
    /<link rel="stylesheet" href="styles\.css"\s*\/?>/,
    `<style>\n${css.trim()}\n</style>`,
  )
  .replace(
    /<script type="module" src="js\/app\.js"><\/script>/,
    `<script>\n(function () {\n'use strict';\n${bundle}\n})();\n</script>`,
  );

if (!output.includes('===== js/app.js =====')) {
  throw new Error('ไม่พบจุดแทรกสคริปต์ — ตรวจ index.html อีกครั้ง');
}
if (output.includes('src="js/')) {
  throw new Error('ยังมีไฟล์ภายนอกอ้างอิงอยู่ — ไฟล์เดียวจะไม่สมบูรณ์');
}

const target = path.join(ROOT, 'spectro-dose.html');
writeFileSync(target, output, 'utf8');
console.log(`สร้าง ${path.basename(target)} สำเร็จ (${(Buffer.byteLength(output) / 1024).toFixed(1)} KB)`);
