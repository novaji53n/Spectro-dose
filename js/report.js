/**
 * report.js — สร้างโมเดลรายงาน, ไฟล์ Excel และหน้ารายงานสำหรับพิมพ์/บันทึกเป็น PDF
 */

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatAbs(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(3);
}

export function formatDoseValue(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('th-TH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('th-TH', { hour12: false });
}

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} params
 * @param {object[]} params.readings
 * @param {object} params.calibration
 * @param {object} params.settings
 * @param {(r:object)=>number|null} params.doseOf
 * @param {(r:object)=>number|null} params.absOf
 */
export function buildReportModel({ readings, calibration, settings, doseOf, absOf, energy = null }) {
  const isTable = calibration.mode === 'table';
  const a0 = Number(calibration.a0) || 0;

  const rows = (readings || []).map((reading, index) => {
    const abs = absOf(reading);
    return {
      no: index + 1,
      time: new Date(reading.t),
      raw: reading.raw,
      value: reading.value,
      unit: reading.unit,
      abs: abs === null || abs === undefined ? null : abs,
      net: abs === null || abs === undefined ? null : abs - (isTable ? 0 : a0),
      dose: doseOf(reading),
      note: reading.note || '',
    };
  });

  const absValues = rows.map((r) => r.abs).filter((v) => v !== null && Number.isFinite(v));
  const n = rows.length;
  const mean = absValues.length ? absValues.reduce((a, b) => a + b, 0) / absValues.length : null;
  let sd = null;
  if (absValues.length > 1 && mean !== null) {
    const variance = absValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (absValues.length - 1);
    sd = Math.sqrt(variance);
  }

  const points = Array.isArray(calibration.table) ? calibration.table : [];

  return {
    generatedAt: new Date(),
    device: {
      baudRate: settings.baudRate,
      dataBits: settings.dataBits,
      stopBits: settings.stopBits,
      parity: settings.parity,
      portLabel: settings.portLabel || '',
    },
    calibration: {
      enabled: Boolean(calibration.enabled),
      mode: isTable ? 'table' : 'formula',
      a0: isTable ? null : a0,
      k1: Number(calibration.k1) || 0,
      k2: Number(calibration.k2) || 0,
      unit: settings.doseUnit || 'Gy',
      points: points.length,
      range: points.length ? [points[0].a, points[points.length - 1].a] : null,
      name: calibration.tableName || '',
      table: points,
    },
    stats: {
      n,
      mean,
      sd,
      min: absValues.length ? Math.min(...absValues) : null,
      max: absValues.length ? Math.max(...absValues) : null,
    },
    rows,
    energy,
  };
}

/* ------------------------------------------------------------------ */
/* Excel workbook                                                      */
/* ------------------------------------------------------------------ */

export function buildReportWorkbook(model, images = {}) {
  const readingsHeader = [
    'ลำดับ', 'เวลา', 'ค่าดิบ', 'ค่า', 'หน่วย',
    'Absorbance', 'Net absorbance', 'Dose', 'หน่วยโดส', 'หมายเหตุ',
  ];

  const readingRows = model.rows.map((row) => [
    row.no,
    formatDateTime(row.time),
    row.raw,
    Number.isFinite(row.value) ? row.value : '',
    row.unit,
    row.abs === null ? '' : Number(row.abs.toFixed(4)),
    row.net === null ? '' : Number(row.net.toFixed(4)),
    row.dose === null ? '' : Number(row.dose.toFixed(4)),
    model.calibration.unit,
    row.note,
  ]);

  const infoRows = [
    ['รายงาน', model.energy && model.stats.n === 0 ? 'ผลการวัดพลังงานลำอิเล็กตรอน' : 'ผลการอ่านค่าจาก Spectrophotometer'],
    ['สร้างเมื่อ', formatDateTime(model.generatedAt)],
    ['จำนวนรายการ', model.stats.n],
    ['ค่าเฉลี่ย (A)', model.stats.mean === null ? '' : Number(model.stats.mean.toFixed(4))],
    ['SD (A)', model.stats.sd === null ? '' : Number(model.stats.sd.toFixed(4))],
    ['ต่ำสุด (A)', model.stats.min === null ? '' : Number(model.stats.min.toFixed(4))],
    ['สูงสุด (A)', model.stats.max === null ? '' : Number(model.stats.max.toFixed(4))],
    ['การสอบเทียบ', model.calibration.mode === 'table' ? 'ตาราง (interpolation)' : 'สูตร k1/k2'],
    ['A0', model.calibration.a0 === null ? 'ไม่ใช้ (โหมดตาราง)' : model.calibration.a0],
    ['k1', model.calibration.k1],
    ['k2', model.calibration.k2],
    ['หน่วยโดส', model.calibration.unit],
    ['จำนวนจุดในตาราง', model.calibration.points],
    ['ช่วงตาราง (A)', model.calibration.range ? `${model.calibration.range[0]} – ${model.calibration.range[1]}` : ''],
    ['ไฟล์ตาราง', model.calibration.name],
    ['Baud rate', model.device.baudRate],
    ['Data bits', model.device.dataBits],
    ['Stop bits', model.device.stopBits],
    ['Parity', model.device.parity],
    ['โปรแกรม', 'Spectro Dose Reader (Web Serial)'],
  ];

  const calibrationRows =
    model.calibration.mode === 'table' && model.calibration.points > 0
      ? [['Absorbance', 'Dose'], ...(model.calibration.table || []).map((p) => [p.a, p.dose])]
      : [
          ['พารามิเตอร์', 'ค่า'],
          ['A0', model.calibration.a0 === null ? 'ไม่ใช้ (โหมดตาราง)' : model.calibration.a0],
          ['k1', model.calibration.k1],
          ['k2', model.calibration.k2],
          ['หน่วยโดส', model.calibration.unit],
        ];

  let energySheet = null;

  if (model.energy) {
    const e = model.energy;
    const num = (value, digits = 3) => (value === null || value === undefined ? '' : Number(Number(value).toFixed(digits)));
    const energyRows = [
      ['รายการ', 'ค่า'],
      ['พลังงาน Ea (MeV)', num(e.ea, 3)],
      ['พลังงาน Ep (MeV)', num(e.ep, 3)],
      ['Dmax', num(e.dmax, 3)],
      ['R50 (cm)', num(e.r50, 3)],
      ['Rp (cm)', num(e.rp, 3)],
      ['ช่วง fit', e.fit.from === null ? '' : `${e.fit.from}–${e.fit.to} (${e.fit.auto ? 'อัตโนมัติ' : 'เลือกเอง'})`],
      ['จำนวนจุด', e.fit.n],
      ['slope', num(e.fit.slope, 4)],
      ['R²', num(e.fit.r2, 5)],
      ['หน่วยโดส', e.unit],
      [],
      e.mode === 'dose' ? ['#', 'Depth (cm)', 'Dose'] : ['#', 'Depth (cm)', 'Ai', 'Dose'],
      ...e.rows.map((row) =>
        e.mode === 'dose' ? [row.no, row.depth, num(row.dose, 3)] : [row.no, row.depth, row.ai, num(row.dose, 3)],
      ),
    ];
    energySheet = { name: 'Energy', rows: energyRows };

    infoRows.push(
      [],
      ['ผลการวัดพลังงาน', ''],
      ['Ea (MeV)', num(e.ea, 3)],
      ['Ep (MeV)', num(e.ep, 3)],
      ['Dmax', num(e.dmax, 3)],
      ['R50 (cm)', num(e.r50, 3)],
      ['Rp (cm)', num(e.rp, 3)],
      ['ช่วง fit', e.fit.from === null ? '' : `${e.fit.from}–${e.fit.to} (${e.fit.auto ? 'อัตโนมัติ' : 'เลือกเอง'})`],
      ['R²', num(e.fit.r2, 5)],
    );
  }

  const hasReadings = model.stats.n > 0;
  const sheets = [];

  // รายงานพลังงานล้วน: ให้ชีต Energy ขึ้นเป็นแผ่นแรกเลย จะได้เห็นข้อมูลทันที
  if (energySheet && !hasReadings) sheets.push(energySheet);
  if (hasReadings) sheets.push({ name: 'Readings', rows: [readingsHeader, ...readingRows] });
  sheets.push({ name: 'Calibration', rows: calibrationRows });
  if (energySheet && hasReadings) sheets.push(energySheet);
  sheets.push({ name: 'Info', rows: infoRows });

  // ฝังกราฟเป็นรูปในชีต (Excel อ่านรูปได้)
  for (const sheet of sheets) {
    if (sheet.name === 'Readings' && images.readings) {
      sheet.images = [{ data: images.readings, width: 900, height: 260, fromCol: 9, fromRow: 1 }];
    }
    if (sheet.name === 'Energy' && images.energy) {
      sheet.images = [{ data: images.energy, width: 900, height: 280, fromCol: 5, fromRow: 1 }];
    }
  }

  return sheets;
}

/* ------------------------------------------------------------------ */
/* print report (HTML)                                                 */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function metaItem(label, value) {
  const box = el('div');
  box.append(el('b', null, label), el('span', null, value));
  return box;
}

export function renderPrintReport(model, container, options = {}) {
  container.replaceChildren();

  const energy = model.energy;
  const hasReadings = model.stats.n > 0;
  const title = energy && !hasReadings
    ? 'รายงานผลการวัดพลังงานลำอิเล็กตรอน'
    : 'รายงานผลการอ่านค่าจาก Spectrophotometer';

  const head = el('header', 'pr-head');
  head.append(
    el('h1', null, title),
    el('p', null, `Thermo Spectronic Genesys 20 · สร้างเมื่อ ${formatDateTime(model.generatedAt)}`),
  );

  const calText =
    model.calibration.mode === 'table'
      ? `ตารางสอบเทียบ ${model.calibration.points} จุด${model.calibration.range ? ` (A ${formatAbs(model.calibration.range[0])} – ${formatAbs(model.calibration.range[1])})` : ''}`
      : `สูตร D = k1·(A − A0) + k2·(A − A0)²  (k1=${model.calibration.k1}, k2=${model.calibration.k2})`;

  const meta = el('div', 'pr-meta');
  meta.append(
    metaItem('จำนวนรายการ', `${model.stats.n} ค่า`),
    metaItem('ค่าเฉลี่ย (A)', model.stats.mean === null ? '—' : model.stats.mean.toFixed(3)),
    metaItem('SD (A)', model.stats.sd === null ? '—' : model.stats.sd.toFixed(4)),
    metaItem('ช่วงค่า (A)', model.stats.min === null ? '—' : `${model.stats.min.toFixed(3)} – ${model.stats.max.toFixed(3)}`),
    metaItem('A0 (blank)', model.calibration.a0 === null ? '—' : model.calibration.a0),
    metaItem('การสอบเทียบ', calText),
    metaItem('อุปกรณ์', `${model.device.baudRate} ${model.device.dataBits}-${String(model.device.parity).charAt(0).toUpperCase()}-${model.device.stopBits}`),
  );

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const title of ['#', 'เวลา', 'ค่าที่อ่าน', 'A', 'Net A', 'โดส', `หน่วย`, 'หมายเหตุ']) {
    headRow.appendChild(el('th', null, title));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of model.rows) {
    const tr = el('tr');
    tr.append(
      el('td', null, row.no),
      el('td', null, formatTime(row.time)),
      el('td', null, `${row.value} ${row.unit}`),
      el('td', null, formatAbs(row.abs)),
      el('td', null, formatAbs(row.net)),
      el('td', null, formatDoseValue(row.dose)),
      el('td', null, model.calibration.unit),
      el('td', null, row.note),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const foot = el('div', 'pr-foot');
  foot.append(
    el('span', null, 'Spectro Dose Reader — Genesys 20 (Web Serial)'),
    el('span', null, `พิมพ์เมื่อ ${formatDateTime(new Date())}`),
  );

  const parts = [head];

  if (hasReadings) {
    parts.push(meta);

    if (Array.isArray(options.charts)) {
      for (const chart of options.charts) {
        if (!chart || !chart.src) continue;
        const figure = el('figure', 'pr-chart');
        const img = document.createElement('img');
        img.src = chart.src;
        img.alt = chart.caption || 'กราฟ';
        figure.append(img, el('figcaption', null, chart.caption || ''));
        parts.push(figure);
      }
    }

    if (options.note) {
      parts.push(el('p', 'pr-note', options.note));
    }

    parts.push(table);
  }

  if (energy) {
    parts.push(buildEnergyBlock(energy, options.energyChart));
  }

  parts.push(foot);
  container.append(...parts);
}

function buildEnergyBlock(energy, chartSrc) {
  const section = el('section', 'pr-energy');
  section.appendChild(el('h2', null, 'ผลการวัดพลังงานลำอิเล็กตรอน'));

  const grid = el('div', 'pr-meta');
  grid.append(
    metaItem('Dmax', energy.dmax === null ? '—' : `${energy.dmax.toFixed(3)} ${energy.unit}`),
    metaItem('R50 (cm)', energy.r50 === null ? '—' : energy.r50.toFixed(3)),
    metaItem('Rp (cm)', energy.rp === null ? '—' : energy.rp.toFixed(3)),
    metaItem('Ea (MeV)', energy.ea === null ? '—' : energy.ea.toFixed(3)),
    metaItem('Ep (MeV)', energy.ep === null ? '—' : energy.ep.toFixed(3)),
    metaItem('ช่วง fit', energy.fit.from === null ? '—' : `${energy.fit.from}–${energy.fit.to} (${energy.fit.auto ? 'อัตโนมัติ' : 'เลือกเอง'}) · ${energy.fit.n} จุด`),
    metaItem('slope / R²', `${energy.fit.slope === null ? '—' : energy.fit.slope.toFixed(4)} / ${energy.fit.r2 === null ? '—' : energy.fit.r2.toFixed(5)}`),
    metaItem('อุปกรณ์', 'Genesys 20 · 552 nm'),
  );
  section.appendChild(grid);
  section.appendChild(el('p', 'pr-note', 'tangent → R50/Rp → Ea/Ep (ISO/ASTM A3.19, A3.18 · ICRU 35)'));

  if (chartSrc) {
    const figure = el('figure', 'pr-chart');
    const img = document.createElement('img');
    img.src = chartSrc;
    img.alt = 'กราฟ depth–dose';
    figure.append(img, el('figcaption', null, 'กราฟ depth–dose (Dose vs Depth) พร้อมเส้น tangent'));
    section.appendChild(figure);
  }

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  const doseMode = energy.mode === 'dose';
  const headings = doseMode ? ['#', 'Depth (cm)', `Dose (${energy.unit})`] : ['#', 'Depth (cm)', 'Ai', `Dose (${energy.unit})`];
  for (const heading of headings) {
    headRow.appendChild(el('th', null, heading));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of energy.rows) {
    const tr = el('tr');
    tr.append(el('td', null, row.no), el('td', null, row.depth === null ? '—' : Number(row.depth).toFixed(4)));
    if (!doseMode) tr.appendChild(el('td', null, formatAbs(row.ai)));
    tr.appendChild(el('td', null, formatDoseValue(row.dose)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);

  return section;
}

/* ------------------------------------------------------------------ */
/* energy Excel form (Dose Conversion template)                        */
/* ------------------------------------------------------------------ */

/**
 * สร้างสมุดงานฟอร์มวัดพลังงานแบบเดียวกับ energy test.xlsx
 * - ชีต Dose Conversion: ตาราง Ai/Depth/Response/Dose(VLOOKUP)/Adjusted Dose + สูตรคำนวณพลังงาน
 * - ชีต Dose Table: ตารางสอบเทียบ (Ai → Dose) ที่ฝังมาเพื่อให้ VLOOKUP ทำงานใน Excel
 */
export function buildEnergyFormWorkbook({
  depths = [],
  ais = [],
  unit = 'kGy',
  table = [],
  fitFrom = 1,
  fitTo = 1,
  correction = 1,
  ao = 0,
  thickness = 0.018,
}) {
  const rows = [];
  const push = (...cells) => {
    rows.push(cells);
    return rows.length;
  };

  const responses = table.map((point) => (Number(point.a) - ao) / thickness).filter((value) => Number.isFinite(value));
  const minResponse = responses.length ? Math.min(...responses) : '';
  const maxResponse = responses.length ? Math.max(...responses) : '';

  // ---- หัวฟอร์ม (ตำแหน่งเดียวกับ energy test.xlsx) ----
  push('DOSE CONVERSION SHEET — ENERGY');
  push('', 'Correction Factor:', correction);
  push('Dose Table = ตารางสอบเทียบที่นำเข้า (ใช้ช่วง A2:E ของชีต Dose Table ใน VLOOKUP)');
  push('', 'Average Ao (Original Absorbance):', ao);
  push('', 'Average Thickness (t):', thickness);
  push('', 'Min Response:', minResponse);
  push('', 'Max Response:', maxResponse);

  const headerRow = push(
    'Dosimeter ID',
    'Depth in Al (cm)',
    'Irradiated Absorbance (Ai)',
    'Response (Ai - Ao) / t [ข้อมูลอ้างอิง]',
    `Dose (${unit}) [VLOOKUP จาก Ai]`,
    `Adjusted Dose (${unit})`,
  );
  push('← Enter Ai values in column C');

  const first = rows.length + 1;
  const tableLast = table.length + 1;

  for (let i = 0; i < depths.length; i += 1) {
    const r = first + i;
    const ai = ais[i];
    push(
      i + 1,
      depths[i] === null || depths[i] === undefined ? '' : Number(depths[i]),
      ai === null || ai === undefined || ai === '' ? '' : Number(ai),
      { f: `IF(C${r}="","",(C${r}-$C$4)/$C$5)` },
      { f: `IF(C${r}="","",IFERROR(VLOOKUP(C${r},'Dose Table'!$A$2:$E$${tableLast},5,TRUE()),"Out of range"))` },
      { f: `IF(E${r}="","",IFERROR(E${r}*$C$2,""))` },
    );
  }

  const last = first + depths.length - 1;

  // ---- สรุปผล (เหมือนตัวอย่าง: ป้ายคอลัมน์ A, ค่า C) ----
  push();
  const maxRow = push('Max Dose in Process:', '', { f: `IFERROR(MAX(E${first}:E${last}),"")` });
  const d50Row = push('D50 (1/2 Max Dose):', '', { f: `IFERROR(C${maxRow}/2,"")` });
  push();
  push('ENERGY CALCULATION (from Extrapolated Range)');

  const f1 = first + Math.max(0, fitFrom - 1);
  const f2 = first + Math.max(0, fitTo - 1);

  // แถวเดียวมี 2 ค่า: Slope (B) + Y-Intercept (D)
  const slopeRow = push(
    'Slope:',
    { f: `IFERROR(SLOPE(F${f1}:F${f2},B${f1}:B${f2}),"")` },
    'Y-Intercept:',
    { f: `IFERROR(INTERCEPT(F${f1}:F${f2},B${f1}:B${f2}),"")` },
  );

  // R50 (B) + Rp (D)
  const r50Row = push(
    'R50:',
    { f: `IFERROR((C${d50Row}-D${slopeRow})/B${slopeRow},"")` },
    'Rp:',
    { f: `IFERROR(-D${slopeRow}/B${slopeRow},"")` },
  );

  // Ea (B) + Ep (D)
  push(
    'Ea (MeV):',
    { f: `IFERROR(0.99*6.2*B${r50Row},"")` },
    'Ep (MeV):',
    { f: `IFERROR(TEXT(0.99*5.09*D${r50Row}+0.2,"0.000"),"")` },
  );

  push();
  push(`Fit rows: ${fitFrom}–${fitTo} (Dosimeter ID)`);

  const tableRows = [['Absorbance (Ai)', '', '', '', `Dose (${unit})`]];
  for (const point of table) tableRows.push([point.a, '', '', '', point.dose]);

  return [
    { name: 'Dose Conversion', rows },
    { name: 'Dose Table', rows: tableRows },
  ];
}