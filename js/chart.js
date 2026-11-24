/**
 * กราฟ depth–dose (PDD) แกน X = ระยะลึก (cm), แกน Y = โดส
 * วาดเส้นข้อมูล + เส้น tangent (ถ้ามี) + จุด R50/Rp
 */
export function drawDepthDoseChart(canvas, points, options = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Number(options.width) || canvas.clientWidth || 400;
  const height = Number(options.height) || canvas.clientHeight || 180;

  const pixelW = Math.round(width * dpr);
  const pixelH = Math.round(height * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 16, right: 12, bottom: 26, left: 46 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  const valid = (points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);

  if (valid.length === 0) {
    ctx.fillStyle = COLORS.empty;
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ยังไม่มีข้อมูล depth–dose', width / 2, height / 2);
    return;
  }

  const xs = valid.map((p) => p.x);
  const ys = valid.map((p) => p.y);
  let xmin = Math.min(...xs);
  let xmax = Math.max(...xs);
  let ymin = 0;
  let ymax = Math.max(...ys) * 1.1;

  if (xmin === xmax) {
    xmin -= 0.1;
    xmax += 0.1;
  }
  if (!(ymax > 0)) ymax = 1;

  const xOf = (x) => pad.left + ((x - xmin) / (xmax - xmin)) * plotW;
  const yOf = (y) => pad.top + plotH - ((y - ymin) / (ymax - ymin)) * plotH;

  // grid + แกน Y
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const value = ymin + ((ymax - ymin) * i) / 4;
    const y = yOf(value);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(value.toFixed(1), pad.left - 6, y);
  }

  // แกน X
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 3; i += 1) {
    const value = xmin + ((xmax - xmin) * i) / 3;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(value.toFixed(2), xOf(value), pad.top + plotH + 6);
  }

  // พื้นที่ใต้เส้น
  ctx.beginPath();
  ctx.moveTo(xOf(valid[0].x), pad.top + plotH);
  valid.forEach((p) => ctx.lineTo(xOf(p.x), yOf(p.y)));
  ctx.lineTo(xOf(valid[valid.length - 1].x), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15, 118, 110, 0.10)';
  ctx.fill();

  // เส้นข้อมูล
  ctx.beginPath();
  valid.forEach((p, index) => {
    if (index === 0) ctx.moveTo(xOf(p.x), yOf(p.y));
    else ctx.lineTo(xOf(p.x), yOf(p.y));
  });
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // เส้น tangent (ถ้ามี)
  if (options.fit) {
    const { slope, intercept } = options.fit;
    const x1 = xmin;
    const y1 = slope * x1 + intercept;
    const x2 = xmax;
    const y2 = slope * x2 + intercept;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xOf(x1), yOf(y1));
    ctx.lineTo(xOf(x2), yOf(y2));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // จุด R50 / Rp
  if (options.markers) {
    const { r50, rp, dmax } = options.markers;
    if (Number.isFinite(r50) && Number.isFinite(dmax)) {
      ctx.fillStyle = '#b45309';
      ctx.beginPath();
      ctx.arc(xOf(r50), yOf(dmax / 2), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (Number.isFinite(rp)) {
      ctx.strokeStyle = 'rgba(180, 83, 9, 0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xOf(rp), pad.top);
      ctx.lineTo(xOf(rp), pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ป้ายชื่อแกน
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(options.unit ? `Dose (${options.unit})` : 'Dose', pad.left, 2);
  ctx.textAlign = 'right';
  ctx.fillText('Depth (cm)', width - pad.right, height - 12);
}


const COLORS = {
  line: '#0f766e',
  fill: 'rgba(15, 118, 110, 0.10)',
  grid: '#eef1f5',
  text: '#667085',
  empty: '#98a2b3',
};

function decimalsFor(span) {
  if (span >= 100) return 0;
  if (span >= 10) return 1;
  if (span >= 1) return 2;
  if (span >= 0.1) return 3;
  return 4;
}

export function drawLineChart(canvas, values, options = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Number(options.width) || canvas.clientWidth || 600;
  const height = Number(options.height) || canvas.clientHeight || 220;

  const pixelW = Math.round(width * dpr);
  const pixelH = Math.round(height * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 16, right: 14, bottom: 26, left: 52 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  if (!values || values.length === 0) {
    ctx.fillStyle = COLORS.empty;
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ยังไม่มีข้อมูล', width / 2, height / 2);
    return;
  }

  const lineColor = options.color || COLORS.line;
  const fillColor = options.fillColor || COLORS.fill;

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    const span = Math.abs(min) * 0.05 || 0.01;
    min -= span;
    max += span;
  } else {
    const padValue = (max - min) * 0.12;
    min -= padValue;
    max += padValue;
  }

  const format = options.format || ((value) => Number(value).toFixed(decimalsFor(max - min)));

  const yOf = (value) => pad.top + plotH - ((value - min) / (max - min)) * plotH;
  const xOf = (index) =>
    values.length === 1 ? pad.left + plotW / 2 : pad.left + (index / (values.length - 1)) * plotW;

  // เส้นกริดแนวนอน + ป้ายค่า
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i += 1) {
    const value = min + ((max - min) * i) / gridCount;
    const y = yOf(value);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(format(value), pad.left - 8, y);
  }

  // พื้นที่ใต้เส้น
  ctx.beginPath();
  ctx.moveTo(xOf(0), pad.top + plotH);
  values.forEach((value, index) => ctx.lineTo(xOf(index), yOf(value)));
  ctx.lineTo(xOf(values.length - 1), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // เส้นข้อมูล
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = xOf(index);
    const y = yOf(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // จุดข้อมูล (แสดงเฉพาะจุดสุดท้ายและจุดแรกเมื่อมีข้อมูลเยอะ)
  const showDots = values.length <= 40;
  values.forEach((value, index) => {
    if (!showDots && index !== values.length - 1) return;
    ctx.beginPath();
    ctx.arc(xOf(index), yOf(value), index === values.length - 1 ? 3.5 : 2.2, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    if (index === values.length - 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  });
}
