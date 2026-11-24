import { MODES, REASONS, parseLine, toAbsorbance, formatValue, formatDose } from './parser.js';
import { SerialSession } from './serial.js';
import { drawLineChart, drawDepthDoseChart } from './chart.js';
import { buildXlsx, readXlsx } from './xlsx.js';
import { buildCalibrationPoints, doseFromPoints, parseCsv } from './calibration.js';
import { computeEnergy, createStandardRows, simulateDepthDose, STANDARD_DEPTHS } from './energy.js';
import { buildReportModel, buildReportWorkbook, renderPrintReport } from './report.js';

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'spectro-dose-reader/v1';
const MAX_READINGS = 1500;
const MAX_TABLE_ROWS = 250;
const CHART_POINTS = 60;

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

function defaultState() {
  return {
    settings: {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      mode: 'auto',
      regex: '',
      lineEnding: 'CR',
      command: 'SND',
      doseUnit: 'Gy',
      metric: 'abs',
      hexRaw: false,
      pollSec: 1,
      lastVid: null,
      lastPid: null,
    },
    calibration: { enabled: false, mode: 'formula', a0: 0, k1: 1, k2: 0, table: [], tableName: '' },
    energy: {
      autoFit: true,
      fitFrom: 15,
      fitTo: 21,
      rows: createStandardRows(),
    },
    readings: [],
    seq: 0,
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const energy = { ...base.energy, ...(saved.energy || {}) };
    if (!Array.isArray(energy.rows) || energy.rows.length === 0) {
      energy.rows = createStandardRows();
    } else {
      const hasData = energy.rows.some(
        (row) => row && ((row.depth !== null && row.depth !== '') || (row.ai !== null && row.ai !== '')),
      );
      if (!hasData) energy.rows = createStandardRows();
    }
    return {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings || {}) },
      calibration: { ...base.calibration, ...(saved.calibration || {}) },
      energy,
      readings: Array.isArray(saved.readings) ? saved.readings.slice(-MAX_READINGS) : [],
    };
  } catch {
    return base;
  }
}

let state = loadState();
let ignoredLines = 0;
let rawLog = '';
let rawRenderQueued = false;
let demoTimer = 0;
let pollTimer = 0;
let toastTimer = 0;
let saveTimer = 0;
let sndPending = false;
let sndTimer = 0;
let modalOpen = false;
let audioCtx = null;
let ctrlDown = false;
let shiftLeftDown = false;
let shiftPending = false;
let shiftTimer = 0;
let lastEnergyResult = null;
let energyAnchor = null;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function num(value, fallback = 0) {  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage เต็มหรือถูกปิด — ไม่เป็นไร ยังใช้งานต่อได้ */
    }
  }, 250);
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('th-TH', { hour12: false });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function doseOf(reading) {
  const cal = state.calibration;
  if (!cal.enabled) return null;
  const abs = toAbsorbance(reading.value, reading.unit);
  if (abs === null) return null;

  if (cal.mode === 'table') {
    // โหมดตาราง: ใช้ค่า A ตามที่วัดไปเทียบ map ตรง ๆ (ไม่หัก A0)
    const table = Array.isArray(cal.table) ? cal.table : [];
    if (table.length === 0) return null;
    return doseFromPoints(abs, table);
  }

  const net = abs - num(cal.a0);
  return num(cal.k1) * net + num(cal.k2) * net * net;
}

function nextId() {
  state.seq = (state.seq || 0) + 1;
  return `${Date.now().toString(36)}-${state.seq}`;
}

/* ------------------------------------------------------------------ */
/* serial                                                              */
/* ------------------------------------------------------------------ */

const session = new SerialSession({
  onLine: handleLine,
  onRaw: handleRaw,
  onStatus: handleStatus,
  onError: handleSerialError,
});

function serialOptions() {
  const s = state.settings;
  return {
    baudRate: num(s.baudRate, 9600),
    dataBits: num(s.dataBits, 8),
    stopBits: num(s.stopBits, 1),
    parity: s.parity,
    flowControl: s.flowControl,
    bufferSize: 255,
  };
}

/* ---------- รายการพอร์ต ---------- */

let knownPorts = [];
let selectedPortIndex = -1;

const USB_CHIPS = {
  '1a86:7523': 'CH340',
  '1a86:5523': 'CH341',
  '1a86:55d4': 'CH9102',
  '0403:6001': 'FTDI FT232',
  '0403:6015': 'FTDI FT231',
  '067b:2303': 'PL2303',
  '10c4:ea60': 'CP210x',
  '10c4:ea70': 'CP2105',
  '2341:0043': 'Arduino',
};

function hex4(value) {
  return typeof value === 'number' ? value.toString(16).padStart(4, '0') : '';
}

function describePort(port, index) {
  let info = {};
  try {
    info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  } catch {
    info = {};
  }
  const key = hex4(info.usbVendorId) && hex4(info.usbProductId)
    ? `${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`
    : '';
  const chip = key ? USB_CHIPS[key] : '';
  const detail = chip ? ` — ${chip}` : key ? ` — USB ${key}` : '';
  return `พอร์ต ${index + 1}${detail}`;
}

function renderPortOptions() {
  const select = $('selPort');
  const connected = Boolean(session.port);
  select.replaceChildren();

  if (knownPorts.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '— ยังไม่มีพอร์ตที่อนุญาต —';
    select.appendChild(option);
    selectedPortIndex = -1;
    select.value = '';
    select.disabled = connected;
    return;
  }

  knownPorts.forEach((port, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = describePort(port, index);
    select.appendChild(option);
  });

  selectedPortIndex = Math.min(Math.max(selectedPortIndex, 0), knownPorts.length - 1);
  select.value = String(selectedPortIndex);
  select.disabled = connected;
}

function rememberPort() {
  const port = knownPorts[selectedPortIndex];
  if (!port) return;
  let info = {};
  try {
    info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  } catch {
    info = {};
  }
  state.settings.lastVid = info.usbVendorId ?? null;
  state.settings.lastPid = info.usbProductId ?? null;
  save();
}

async function refreshPorts(preferredPort = null) {
  if (!SerialSession.supported) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (preferredPort && !ports.includes(preferredPort)) ports.push(preferredPort);
    knownPorts = ports;

    if (preferredPort) {
      const index = ports.indexOf(preferredPort);
      if (index >= 0) selectedPortIndex = index;
    }
    renderPortOptions();
  } catch {
    /* เบราว์เซอร์อาจไม่ให้อ่านรายการ — ยังใช้ chooser ได้ */
  }
}

async function initPorts() {
  if (!SerialSession.supported) {
    $('btnPickPort').disabled = true;
    $('btnRefreshPorts').disabled = true;
    $('selPort').disabled = true;
    return;
  }

  await refreshPorts();

  const { lastVid, lastPid } = state.settings;
  if (lastVid !== null && lastPid !== null) {
    const index = knownPorts.findIndex((port) => {
      try {
        const info = port.getInfo ? port.getInfo() : {};
        return info.usbVendorId === lastVid && info.usbProductId === lastPid;
      } catch {
        return false;
      }
    });
    if (index >= 0) {
      selectedPortIndex = index;
      renderPortOptions();
    }
  }

  try {
    navigator.serial.addEventListener('connect', () => { refreshPorts(); });
    navigator.serial.addEventListener('disconnect', () => { refreshPorts(); });
  } catch {
    /* บางเบราว์เซอร์ไม่รองรับ event */
  }
}

async function pickPort() {
  try {
    const port = await navigator.serial.requestPort();
    await refreshPorts(port);
    rememberPort();
    toast('เพิ่มพอร์ตแล้ว — กด “เชื่อมต่อ” เพื่อเริ่มใช้งาน');
  } catch (err) {
    if (err && err.name === 'NotFoundError') return; // ผู้ใช้กดยกเลิก
    toast(`เลือกพอร์ตไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

function setConnectedUI(connected) {
  $('btnConnect').disabled = connected;
  $('btnDisconnect').disabled = !connected;
  $('btnSend').disabled = !connected;
  $('btnSndTop').disabled = !connected;
  $('btnCmdModel').disabled = !connected;
  $('btnCmdRev').disabled = !connected;
  $('selPort').disabled = connected;
  $('btnPickPort').disabled = connected;
  $('btnRefreshPorts').disabled = connected;
  for (const id of ['selBaud', 'selDataBits', 'selStopBits', 'selParity', 'selFlow']) {
    $(id).disabled = connected;
  }
  if (!SerialSession.supported) {
    $('selPort').disabled = true;
    $('btnPickPort').disabled = true;
    $('btnRefreshPorts').disabled = true;
  }
}

function setStatus(kind, text) {
  $('statusChip').dataset.state = kind;
  $('statusText').textContent = text;
}

function handleStatus(status) {
  if (status === 'open') {
    setStatus('connected', 'เชื่อมต่อแล้ว');
    setConnectedUI(true);
    $('actionNote').textContent = 'พร้อมอ่านค่า — กดปุ่มนี้หรือ Ctrl+Shift (ซ้าย)';
    if ($('chkPoll').checked) startPoll();
  } else if (status === 'closed') {
    setStatus('idle', 'ยังไม่เชื่อมต่อ');
    setConnectedUI(false);
    $('actionNote').textContent = 'เชื่อมต่อก่อนเพื่อกดอ่านค่า · คีย์ลัด Ctrl+Shift (ซ้าย)';
    stopPoll();
  }
}

async function handleSerialError(err) {
  const message = err && err.message ? err.message : String(err);
  toast(`พอร์ตมีปัญหา: ${message}`);
  stopPoll();
  try {
    await session.disconnect();
  } catch {
    /* ignore */
  }
  setConnectedUI(false);
  setStatus('error', 'การเชื่อมต่อมีปัญหา');
}

async function connectSerial() {
  if (!SerialSession.supported) {
    toast('เบราว์เซอร์นี้ไม่รองรับ Web Serial — ใช้ Chrome หรือ Edge เวอร์ชันใหม่');
    return;
  }
  if (demoTimer) toggleDemo();

  $('btnConnect').disabled = true;
  try {
    const port = selectedPortIndex >= 0 ? knownPorts[selectedPortIndex] : null;
    await session.connect(serialOptions(), port);
    await refreshPorts(session.port);
    rememberPort();
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotFoundError') toast('ยกเลิกการเลือกพอร์ต');
    else if (name === 'SecurityError') toast('เบราว์เซอร์บล็อกสิทธิ์พอร์ตอนุกรม — ใช้ Chrome/Edge เวอร์ชันล่าสุด หรือเปิดผ่าน http://127.0.0.1');
    else if (name === 'NetworkError' || name === 'InvalidStateError') toast('พอร์ตถูกใช้งานอยู่ — ปิดโปรแกรมอื่นที่ต่อพอร์ตนี้ก่อน');
    else toast(`เชื่อมต่อไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  } finally {
    $('btnConnect').disabled = Boolean(session.port);
  }
}

async function disconnectSerial() {
  try {
    await session.disconnect();
  } catch {
    /* ignore */
  } finally {
    setConnectedUI(false);
    setStatus('idle', 'ยังไม่เชื่อมต่อ');
    void refreshPorts();
  }
}

async function sendCommand() {
  const text = $('inpCommand').value;
  if (!text.trim()) {
    toast('พิมพ์คำสั่งก่อน');
    return;
  }
  try {
    await session.send(text, state.settings.lineEnding);
    if (text.trim().toUpperCase() === 'SND') armSndWait();
  } catch (err) {
    toast(`ส่งไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

/** ปุ่มคำสั่งสำเร็จรูปสำหรับรุ่นนี้ (SND = ขอค่าอ่าน, MODEL/REV = ข้อมูลเครื่อง) */
function sendPreset(command) {
  $('inpCommand').value = command;
  state.settings.command = command;
  state.settings.lineEnding = 'CR';
  $('selLineEnding').value = 'CR';
  save();
  void sendCommand();
}

/* ---------- อ่านค่า SND + popup + เสียง ---------- */

function primeAudio() {
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!audioCtx) audioCtx = new AudioCtor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* ไม่มีเสียงก็ยังใช้งานได้ */
  }
}

function playBeep() {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    for (const [index, frequency] of [880, 1180].entries()) {
      const start = now + index * 0.12;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  } catch {
    /* ignore */
  }
}

function armSndWait() {
  sndPending = true;
  clearTimeout(sndTimer);
  sndTimer = setTimeout(() => {
    if (!sndPending) return;
    sndPending = false;
    toast('ไม่ได้รับค่าจากเครื่องภายใน 5 วินาที');
  }, 5000);
}

/** ส่งคำสั่ง SND เพื่อขอค่าอ่าน (ปุ่มด้านบน / คีย์ลัด) */
function readNow() {
  if (!session.port) {
    toast('เชื่อมต่อก่อนจึงจะอ่านค่าได้');
    return;
  }
  primeAudio();
  void sendPreset('SND');
}

function armCtrlShift() {
  shiftPending = true;
  clearTimeout(shiftTimer);
  shiftTimer = setTimeout(() => {
    shiftPending = false;
  }, 2500);
}

function cancelCtrlShift() {
  shiftPending = false;
  clearTimeout(shiftTimer);
}

function maybeFireCtrlShift() {
  if (!shiftPending) return;
  shiftPending = false;
  clearTimeout(shiftTimer);
  readNow();
}

function fireShortcutRead() {
  shiftPending = false;
  clearTimeout(shiftTimer);
  readNow();
}

function showReadingPopup(reading) {
  const dose = doseOf(reading);
  $('modalAbs').textContent = formatValue(reading.value, reading.unit);
  $('modalAbsUnit').textContent = reading.unit;
  $('modalDose').textContent = dose === null ? '—' : formatDose(dose);
  $('modalDoseUnit').textContent = state.settings.doseUnit;
  $('modalRaw').textContent = reading.raw;
  $('modalRaw').title = reading.raw;
  $('modalTime').textContent = formatClock(reading.t);
  $('readingModal').hidden = false;
  modalOpen = true;
  playBeep();
  setTimeout(() => $('modalOk').focus(), 30);
}

function closeReadingPopup() {
  if (!modalOpen) return;
  $('readingModal').hidden = true;
  modalOpen = false;
}

function startPoll() {
  stopPoll();
  const seconds = Math.max(0.2, num($('inpPollSec').value, 1));
  const command = $('inpCommand').value.trim();
  if (!command) {
    toast('ต้องมีคำสั่งก่อนจึงจะส่งซ้ำได้');
    $('chkPoll').checked = false;
    return;
  }
  pollTimer = setInterval(() => {
    session.send(command, state.settings.lineEnding).catch(() => {});
  }, seconds * 1000);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
}

/* ------------------------------------------------------------------ */
/* readings                                                            */
/* ------------------------------------------------------------------ */

function handleLine(line) {
  const parsed = parseLine(line, { mode: state.settings.mode, regex: state.settings.regex });

  if (!parsed.ok || parsed.value === null || !Number.isFinite(parsed.value)) {
    ignoredLines += 1;
    $('ignoredHits').textContent = `บรรทัดที่แยกค่าไม่ได้: ${ignoredLines}`;
    return;
  }

  const reading = {
    id: nextId(),
    t: new Date().toISOString(),
    raw: line,
    value: parsed.value,
    unit: parsed.unit,
    note: '',
  };

  state.readings.push(reading);
  if (state.readings.length > MAX_READINGS) {
    state.readings.splice(0, state.readings.length - MAX_READINGS);
  }
  save();

  renderCurrent(reading);
  renderStats();
  renderTable();
  renderChart();

  autoCaptureEnergyReading(reading);

  if (sndPending) {
    sndPending = false;
    clearTimeout(sndTimer);
    showReadingPopup(reading);
  }
}

function lastReading() {
  return state.readings.length ? state.readings[state.readings.length - 1] : null;
}

function renderCurrent(reading) {
  const r = reading || lastReading();
  $('curDoseUnit').textContent = state.settings.doseUnit;

  if (!r) {
    $('curValue').textContent = '—';
    $('curUnit').textContent = 'A';
    $('curTime').textContent = '—';
    $('curRaw').textContent = 'ยังไม่มีข้อมูล';
    $('curDose').textContent = '—';
    $('doseBox').classList.add('off');
    return;
  }

  $('curValue').textContent = formatValue(r.value, r.unit);
  $('curUnit').textContent = r.unit === '%T' ? '%T' : 'A';
  $('curTime').textContent = formatClock(r.t);
  $('curRaw').textContent = r.raw;
  $('curRaw').title = r.raw;

  const dose = doseOf(r);
  $('curDose').textContent = formatDose(dose);
  $('doseBox').classList.toggle('off', dose === null);
}

function renderStats() {
  const values = state.readings
    .map((r) => toAbsorbance(r.value, r.unit))
    .filter((v) => v !== null && Number.isFinite(v));

  $('statN').textContent = String(state.readings.length);

  if (values.length === 0) {
    $('statMean').textContent = '—';
    $('statSd').textContent = '—';
    $('statMin').textContent = '—';
    $('statMax').textContent = '—';
    return;
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let sd = '—';
  if (values.length > 1) {
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
    sd = Math.sqrt(variance).toFixed(4);
  }

  $('statMean').textContent = mean.toFixed(3);
  $('statSd').textContent = sd;
  $('statMin').textContent = Math.min(...values).toFixed(3);
  $('statMax').textContent = Math.max(...values).toFixed(3);
}

function buildRow(reading, index) {
  const tr = document.createElement('tr');
  tr.dataset.id = reading.id;

  const tdNo = document.createElement('td');
  tdNo.className = 'num';
  tdNo.textContent = String(index);

  const tdTime = document.createElement('td');
  tdTime.className = 'num';
  tdTime.textContent = formatClock(reading.t);

  const tdValue = document.createElement('td');
  tdValue.textContent = `${formatValue(reading.value, reading.unit)} ${reading.unit}`;

  const abs = toAbsorbance(reading.value, reading.unit);
  const tdAbs = document.createElement('td');
  tdAbs.textContent = abs === null ? '—' : abs.toFixed(3);

  const dose = doseOf(reading);
  const tdDose = document.createElement('td');
  tdDose.className = 'dose-cell';
  tdDose.innerHTML = `<strong>${dose === null ? '—' : formatDose(dose)}</strong>${dose === null ? '' : ` <span class="muted">${state.settings.doseUnit}</span>`}`;

  const tdRaw = document.createElement('td');
  tdRaw.className = 'raw-cell';
  tdRaw.textContent = reading.raw;
  tdRaw.title = reading.raw;

  const tdNote = document.createElement('td');
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'note-input';
  note.placeholder = '—';
  note.value = reading.note || '';
  note.setAttribute('aria-label', 'หมายเหตุ');
  note.addEventListener('change', () => {
    reading.note = note.value.trim();
    save();
  });
  tdNote.appendChild(note);

  const tdAction = document.createElement('td');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.textContent = '×';
  del.title = 'ลบรายการนี้';
  del.setAttribute('aria-label', 'ลบรายการนี้');
  del.addEventListener('click', () => {
    state.readings = state.readings.filter((item) => item.id !== reading.id);
    save();
    refreshDerived();
  });
  tdAction.appendChild(del);

  tr.append(tdNo, tdTime, tdValue, tdAbs, tdDose, tdRaw, tdNote, tdAction);
  return tr;
}

function renderTable() {
  const body = $('tblBody');
  body.replaceChildren();

  $('tblCount').textContent = String(state.readings.length);

  if (state.readings.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'ยังไม่มีข้อมูล — กด “เชื่อมต่อ” หรือ “ทดลองด้วยข้อมูลจำลอง”';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  const total = state.readings.length;
  const slice = state.readings.slice(-MAX_TABLE_ROWS);
  const frag = document.createDocumentFragment();

  slice.forEach((reading, i) => {
    frag.appendChild(buildRow(reading, total - slice.length + i + 1));
  });

  body.appendChild(frag);

  // เลื่อนตารางไปแถวล่าสุดที่เพิ่งอ่าน (ทำซ้ำหลัง layout นิ่ง)
  requestAnimationFrame(() => {
    scrollReadingsToLatest();
    setTimeout(scrollReadingsToLatest, 60);
  });
}

function scrollReadingsToLatest() {
  const view = $('readingsView');
  if (view && view.hidden) return;
  const wrap = view.querySelector('.table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function renderChart() {
  const activePanel = document.querySelector('.tab-panel.is-active');
  const energyMode = activePanel && activePanel.dataset.panel === 'energy';

  if (energyMode && lastEnergyResult) {
    const points = lastEnergyResult.rows
      .filter((row) => row.depth !== null && row.adjusted !== null)
      .map((row) => ({ x: row.depth, y: row.adjusted }));
    drawDepthDoseChart($('chart'), points, {
      fit: lastEnergyResult.fit,
      markers:
        lastEnergyResult.r50 !== null && lastEnergyResult.dmax !== null
          ? { r50: lastEnergyResult.r50, rp: lastEnergyResult.rp, dmax: lastEnergyResult.dmax }
          : null,
      unit: state.settings.doseUnit,
    });
    return;
  }

  const metric = state.settings.metric;
  const values = state.readings
    .map((r) => (metric === 'dose' ? doseOf(r) : toAbsorbance(r.value, r.unit)))
    .filter((v) => v !== null && Number.isFinite(v))
    .slice(-CHART_POINTS);

  drawLineChart($('chart'), values);
}

function refreshDerived() {
  renderCurrent();
  renderStats();
  renderTable();
  renderChart();
}

/* ------------------------------------------------------------------ */
/* parser test box                                                     */
/* ------------------------------------------------------------------ */

function reasonText(reason) {
  return REASONS[reason] || 'อ่านค่าไม่ได้';
}

function updateTest() {
  const line = $('testLine').value;
  const output = $('testResult');

  if (!line.trim()) {
    output.textContent = '—';
    delete output.dataset.state;
    return;
  }

  const parsed = parseLine(line, { mode: state.settings.mode, regex: state.settings.regex });
  if (!parsed.ok) {
    output.textContent = `✕ ${reasonText(parsed.reason)}`;
    output.dataset.state = 'bad';
    return;
  }

  output.textContent = `✓ อ่านได้ ${formatValue(parsed.value, parsed.unit)} ${parsed.unit}`;
  output.dataset.state = 'good';
}

/* ------------------------------------------------------------------ */
/* raw monitor                                                         */
/* ------------------------------------------------------------------ */

const rawDecoder = new TextDecoder('utf-8', { fatal: false });

function handleRaw(bytes) {
  if (state.settings.hexRaw) {
    rawLog += `${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`;
  } else {
    rawLog += rawDecoder.decode(bytes, { stream: true });
  }

  if (rawLog.length > 20000) rawLog = rawLog.slice(-20000);
  queueRawRender();
}

function queueRawRender() {
  if (rawRenderQueued) return;
  rawRenderQueued = true;
  requestAnimationFrame(() => {
    rawRenderQueued = false;
    const details = $('rawDetails');
    if (!details.open) return;
    const box = $('rawLog');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.textContent = rawLog;
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/* demo mode                                                           */
/* ------------------------------------------------------------------ */

function toggleDemo() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = 0;
    $('btnDemo').textContent = 'ทดลองด้วยข้อมูลจำลอง';
    $('btnDemo').classList.remove('primary');
    setStatus('idle', 'ยังไม่เชื่อมต่อ');
    return;
  }

  if (session.port) {
    toast('ตัดการเชื่อมต่อพอร์ตก่อนใช้โหมดทดลอง');
    return;
  }

  $('btnDemo').textContent = 'หยุดโหมดทดลอง';
  $('btnDemo').classList.add('primary');
  setStatus('demo', 'โหมดทดลอง (ข้อมูลจำลอง)');

  let base = 0.35 + Math.random() * 0.2;
  demoTimer = setInterval(() => {
    base += (Math.random() - 0.5) * 0.01;
    base = Math.min(1.6, Math.max(0.02, base));
    handleLine(`600NM ${base.toFixed(3)} A`);
  }, 1500);
}

/* ------------------------------------------------------------------ */
/* export / clear                                                      */
/* ------------------------------------------------------------------ */

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  if (state.readings.length === 0) {
    toast('ยังไม่มีข้อมูลให้ส่งออก');
    return;
  }

  const header = [
    'no', 'time_iso', 'time_local', 'raw', 'value', 'unit',
    'absorbance', 'net_absorbance', 'dose', 'dose_unit', 'note',
  ];

  const rows = state.readings.map((r, i) => {
    const abs = toAbsorbance(r.value, r.unit);
    const net = abs === null ? null : abs - num(state.calibration.a0);
    const dose = doseOf(r);
    return [
      i + 1,
      r.t,
      formatDateTime(r.t),
      r.raw,
      r.value,
      r.unit,
      abs === null ? '' : abs.toFixed(4),
      net === null ? '' : net.toFixed(4),
      dose === null ? '' : dose.toFixed(4),
      state.settings.doseUnit,
      r.note || '',
    ];
  });

  const csv = [header, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `dose-readings-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportEnergyCsv() {
  const result = lastEnergyResult;
  const filled = result ? result.rows.filter((row) => row.ai !== null && row.ai !== '') : [];
  if (!result || filled.length === 0) {
    toast('ยังไม่มีข้อมูลวัดพลังงานให้ส่งออก');
    return;
  }

  const unit = state.settings.doseUnit || 'kGy';
  const num = (value, digits = 3) => (value === null || value === undefined ? '' : Number(value).toFixed(digits));

  const lines = [
    ['# Spectro Dose Reader — วัดพลังงาน (อิเล็กตรอน)'],
    ['# Ea (MeV)', num(result.ea, 2)],
    ['# Ep (MeV)', num(result.ep, 2)],
    [`# Dmax (${unit})`, num(result.dmax, 3)],
    ['# R50 (cm)', num(result.r50, 3)],
    ['# Rp (cm)', num(result.rp, 3)],
    ['# ช่วง fit', result.range ? `${result.range.from}–${result.range.to}` : ''],
    ['# R²', num(result.r2, 5)],
    [],
    ['#', 'Depth (cm)', 'Ai', `Dose (${unit})`],
    ...result.rows.map((row, index) => [
      index + 1,
      row.depth === null ? '' : row.depth,
      row.ai === null || row.ai === '' ? '' : row.ai,
      row.adjusted === null ? '' : Number(row.adjusted.toFixed(3)),
    ]),
  ];

  const csv = lines.map((cols) => cols.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `energy-dose-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearAll() {
  if (state.readings.length === 0) return;
  if (!window.confirm(`ลบข้อมูลทั้งหมด ${state.readings.length} รายการ?`)) return;
  state.readings = [];
  save();
  refreshDerived();
  toast('ล้างข้อมูลแล้ว');
}

/* ------------------------------------------------------------------ */
/* calibration table (import)                                          */
/* ------------------------------------------------------------------ */

function updateCalibrationUI() {
  const cal = state.calibration;
  const isTable = cal.mode === 'table';
  $('formulaFields').hidden = isTable;
  $('a0Field').hidden = isTable;
  $('btnSetA0').hidden = isTable;

  const formula = $('calFormula');
  if (isTable) {
    formula.textContent = 'D = interpolate จากตาราง (ใช้ค่า A ตามที่วัดตรง ๆ)';
  } else {
    formula.innerHTML = 'D = k<sub>1</sub>&middot;(A &minus; A<sub>0</sub>) + k<sub>2</sub>&middot;(A &minus; A<sub>0</sub>)<sup>2</sup>';
  }

  const info = $('calTableInfo');
  const preview = $('calPreview');
  updateCalTest();

  if (!isTable) return;

  if (!cal.table || cal.table.length === 0) {
    info.textContent = 'ยังไม่มีตาราง — กด “นำเข้าตารางสอบเทียบ” เพื่อเลือกไฟล์ Excel/CSV';
    preview.hidden = true;
    preview.open = false;
    $('calPreviewBody').replaceChildren();
    return;
  }

  const first = cal.table[0];
  const last = cal.table[cal.table.length - 1];
  info.textContent = `${cal.tableName || 'ตารางสอบเทียบ'} · ${cal.table.length} จุด · A ${first.a.toFixed(3)} – ${last.a.toFixed(3)} → โดส ${first.dose.toFixed(2)} – ${last.dose.toFixed(2)} ${state.settings.doseUnit}`;
  preview.hidden = false;
  renderCalPreview();
}

/** ทดสอบ map: ใส่ค่า A แล้วดูว่าได้โดสเท่าไร (เทียบกับ Excel ได้เลย) */
function updateCalTest() {
  const input = $('inpCalTest');
  const output = $('calTestResult');
  if (!input || !output) return;

  const raw = input.value.trim();
  if (!raw) {
    output.textContent = '—';
    delete output.dataset.state;
    return;
  }

  const absorbance = Number(raw);
  const table = Array.isArray(state.calibration.table) ? state.calibration.table : [];

  if (!Number.isFinite(absorbance)) {
    output.textContent = 'ค่าไม่ถูกต้อง';
    output.dataset.state = 'bad';
    return;
  }
  if (table.length === 0) {
    output.textContent = 'ยังไม่มีตาราง';
    delete output.dataset.state;
    return;
  }

  const dose = doseFromPoints(absorbance, table);
  if (dose === null) {
    output.textContent = 'หาไม่พบ';
    output.dataset.state = 'bad';
    return;
  }

  const outside = absorbance < table[0].a || absorbance > table[table.length - 1].a;
  output.textContent = `${dose.toFixed(4)} ${state.settings.doseUnit}${outside ? ' (นอกช่วงตาราง)' : ''}`;
  output.dataset.state = outside ? 'bad' : 'good';
}

function renderCalPreview() {
  const body = $('calPreviewBody');
  body.replaceChildren();
  const points = state.calibration.table || [];
  points.slice(0, 40).forEach((point, index) => {
    const tr = document.createElement('tr');
    const tdNo = document.createElement('td');
    tdNo.className = 'num';
    tdNo.textContent = String(index + 1);
    const tdA = document.createElement('td');
    tdA.textContent = point.a.toFixed(4);
    const tdD = document.createElement('td');
    tdD.textContent = point.dose.toFixed(4);
    tr.append(tdNo, tdA, tdD);
    body.appendChild(tr);
  });
}

async function importCalibration(file) {
  try {
    const name = file.name.toLowerCase();
    let rows;

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      rows = parseCsv(await file.text());
    } else {
      const workbook = await readXlsx(await file.arrayBuffer());
      rows = workbook.sheets[0] ? workbook.sheets[0].rows : [];
    }

    const result = buildCalibrationPoints(rows);
    if (result.points.length === 0) {
      toast('ไม่พบข้อมูลในคอลัมน์ A (absorbance) และ B (dose)');
      return;
    }

    state.calibration.table = result.points.slice(0, 5000);
    state.calibration.tableName = file.name;
    state.calibration.mode = 'table';
    state.calibration.enabled = true;
    $('selCalMode').value = 'table';
    $('chkCalib').checked = true;

    // ตารางรูปแบบนี้เก็บโดสเป็น kGy — ตั้งหน่วยให้ตรง (ถ้าหัวตารางระบุหน่วยอื่นจะใช้ค่านั้น)
    if (result.unit) {
      state.settings.doseUnit = result.unit;
      $('selDoseUnit').value = result.unit;
    }

    save();
    updateCalibrationUI();
    refreshDerived();
    updateEnergyUI();
    activateTab('cal');
    toast(`นำเข้าตารางสอบเทียบ ${result.points.length} จุด (หน่วย ${result.unit || 'kGy'})`);
  } catch (err) {
    toast(`อ่านไฟล์ไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ */
/* energy measurement (electron beam)                                  */
/* ------------------------------------------------------------------ */

function renderEnergyTable() {
  const body = $('energyRows');
  body.replaceChildren();

  state.energy.rows.forEach((row, index) => {
    const tr = document.createElement('tr');

    const tdNo = document.createElement('td');
    tdNo.textContent = String(index + 1);

    const tdDepth = document.createElement('td');
    const depth = document.createElement('input');
    depth.type = 'number';
    depth.step = '0.001';
    depth.inputMode = 'decimal';
    depth.placeholder = '0.000';
    depth.value = row.depth === null || row.depth === undefined ? '' : String(row.depth);
    depth.addEventListener('input', () => {
      row.depth = depth.value === '' ? null : Number(depth.value);
      save();
      computeEnergyUI();
    });
    tdDepth.appendChild(depth);

    const tdAi = document.createElement('td');
    const ai = document.createElement('input');
    ai.type = 'number';
    ai.step = '0.0001';
    ai.inputMode = 'decimal';
    ai.placeholder = '—';
    ai.value = row.ai === null || row.ai === undefined ? '' : String(row.ai);
    ai.addEventListener('input', () => {
      row.ai = ai.value === '' ? null : Number(ai.value);
      save();
      computeEnergyUI();
    });
    tdAi.appendChild(ai);

    const tdDose = document.createElement('td');
    tdDose.className = 'dose-cell';
    tdDose.textContent = '—';

    tr.append(tdNo, tdDepth, tdAi, tdDose);

    tr.addEventListener('click', (event) => {
      const target = event.target;
      if (target && target.tagName === 'INPUT') return;
      selectEnergyRow(index + 1);
    });

    body.appendChild(tr);
  });
}

/** คลิกแถวแรก = จุดเริ่ม, คลิกที่สอง = จุดสิ้นสุด (คลิกครั้งแรกจะสลับเป็นโหมดเลือกเอง) */
function selectEnergyRow(rowNumber) {
  if (state.energy.autoFit !== false) {
    state.energy.autoFit = false;
    $('chkEnergyAutoFit').checked = false;
    $('energyFitFields').hidden = false;
    energyAnchor = null;
  }

  if (energyAnchor === null) {
    energyAnchor = rowNumber;
    state.energy.fitFrom = rowNumber;
    state.energy.fitTo = rowNumber;
  } else {
    state.energy.fitFrom = Math.min(energyAnchor, rowNumber);
    state.energy.fitTo = Math.max(energyAnchor, rowNumber);
    energyAnchor = null;
  }

  $('inpEnergyFitFrom').value = String(state.energy.fitFrom);
  $('inpEnergyFitTo').value = String(state.energy.fitTo);
  save();
  computeEnergyUI();
}

function computeEnergyUI() {
  const energy = state.energy;
  const auto = energy.autoFit !== false;
  const result = computeEnergy({
    rows: energy.rows,
    ao: 0,
    thickness: 1,
    correction: 1,
    table: state.calibration.table || [],
    autoFit: auto,
    criterion: 'r2',
    fitFrom: energy.fitFrom,
    fitTo: energy.fitTo,
  });

  const body = $('energyRows');
  result.rows.forEach((row, index) => {
    const tr = body.children[index];
    if (!tr) return;
    const cell = tr.lastElementChild;
    cell.textContent = row.adjusted === null ? '—' : row.adjusted.toFixed(3);
  });
  lastEnergyResult = result;

  const from = result.range ? result.range.from : null;
  const to = result.range ? result.range.to : null;
  [...body.children].forEach((tr, index) => {
    const inRange = from !== null && index + 1 >= from && index + 1 <= to && result.fit !== null;
    tr.classList.toggle('selected', inRange);
  });

  const unit = state.settings.doseUnit || 'kGy';
  $('enDmax').textContent = result.dmax === null ? '—' : `${result.dmax.toFixed(3)} ${unit}`;
  $('enR50').textContent = result.r50 === null ? '—' : result.r50.toFixed(3);
  $('enRp').textContent = result.rp === null ? '—' : result.rp.toFixed(3);
  $('enEa').textContent = result.ea === null ? '—' : result.ea.toFixed(2);
  $('enEp').textContent = result.ep === null ? '—' : result.ep.toFixed(2);

  const progress = $('energyProgress');
  if (progress) {
    const filled = energy.rows.filter((row) => row.ai !== null && row.ai !== '').length;
    progress.textContent = `${filled}/${energy.rows.length}`;
  }

  if (result.error) {
    $('energyNote').textContent = result.error;
    $('energyR2').textContent = 'R² = —';
    delete $('energyR2').dataset.state;
  } else {
    const range = result.range ? `แถว ${result.range.from}–${result.range.to}` : '—';
    const r2Text = result.r2 === null || result.r2 === undefined ? '—' : result.r2.toFixed(5);
    $('energyR2').textContent = `R² = ${r2Text} · slope ${result.fit.slope.toFixed(3)} · ${result.fit.n} จุด`;
    $('energyR2').dataset.state = result.r2 !== null && result.r2 >= 0.98 ? 'good' : 'bad';

    const parts = [
      `fit ${range}${auto ? ' (อัตโนมัติ)' : ' (เลือกเอง)'}`,
      'tangent → R50/Rp → Ea/Ep (ISO/ASTM A3.19, A3.18 · ICRU 35)',
    ];
    if (result.warning) parts.push(`⚠ ${result.warning}`);
    $('energyNote').textContent = parts.join(' · ');
  }

  const activePanel = document.querySelector('.tab-panel.is-active');
  if (activePanel && activePanel.dataset.panel === 'energy') renderChart();
}

function updateEnergyUI() {
  const energy = state.energy;

  $('inpEnergyFitFrom').value = String(energy.fitFrom);
  $('inpEnergyFitTo').value = String(energy.fitTo);

  const auto = energy.autoFit !== false;
  $('chkEnergyAutoFit').checked = auto;
  $('energyFitFields').hidden = auto;

  const table = state.calibration.table || [];
  const info = $('energyCalInfo');
  if (table.length === 0) {
    info.textContent = 'ยังไม่มีตารางสอบเทียบ — นำเข้าที่แท็บ “สอบเทียบ” ก่อน (แท็บนี้ใช้ตารางเดียวกัน)';
  } else {
    const first = table[0];
    const last = table[table.length - 1];
    info.textContent = `ใช้ตารางสอบเทียบร่วมกับแท็บสอบเทียบ: ${table.length} จุด · A ${first.a.toFixed(3)} – ${last.a.toFixed(3)} → ${state.settings.doseUnit}`;
  }

  computeEnergyUI();
}

function addEnergyRows(count = 6) {
  for (let i = 0; i < count; i += 1) state.energy.rows.push({ depth: null, ai: null });
  save();
  renderEnergyTable();
  computeEnergyUI();
}

function clearEnergyRows() {
  if (!window.confirm('ล้างค่า Ai ทั้งหมด และคืนระยะลึกมาตรฐาน 60 ระดับ?')) return;
  state.energy.rows = createStandardRows();
  save();
  renderEnergyTable();
  computeEnergyUI();
}

function captureLatestToEnergy() {
  const reading = lastReading();
  if (!reading) {
    toast('ยังไม่มีค่าที่อ่านได้');
    return;
  }
  const abs = toAbsorbance(reading.value, reading.unit);
  if (abs === null) {
    toast('ค่าล่าสุดแปลงเป็น absorbance ไม่ได้');
    return;
  }

  let target = state.energy.rows.find((row) => row.ai === null || row.ai === '');
  if (!target) {
    target = { depth: null, ai: null };
    state.energy.rows.push(target);
  }
  target.ai = Number(abs.toFixed(4));
  const index = state.energy.rows.indexOf(target);

  save();
  renderEnergyTable();
  computeEnergyUI();

  const rowEl = $('energyRows').children[index];
  if (rowEl) rowEl.scrollIntoView({ block: 'center' });
  toast(`เก็บค่า Ai = ${abs.toFixed(4)} ที่แถว ${index + 1}`);
}

/** ถ้าอยู่แท็บพลังงาน ให้เติมค่า Ai ลงแถวว่างถัดไปตามลำดับระยะลึกอัตโนมัติ */
function autoCaptureEnergyReading(reading) {
  const panel = document.querySelector('.tab-panel.is-active');
  if (!panel || panel.dataset.panel !== 'energy') return;

  const abs = toAbsorbance(reading.value, reading.unit);
  if (abs === null) return;

  const target = state.energy.rows.find((row) => row.ai === null || row.ai === '');
  if (!target) return;

  target.ai = Number(abs.toFixed(4));
  const index = state.energy.rows.indexOf(target);

  save();
  renderEnergyTable();
  computeEnergyUI();

  const rowEl = $('energyRows').children[index];
  if (rowEl) rowEl.scrollIntoView({ block: 'center' });
}

/** จำลอง depth–dose ตามพลังงาน แล้วเติม Ai ลง 60 แถว (ใช้ตารางสอบเทียบ A → Dose) */
function runEnergySimulation() {
  const energy = num($('inpSimEnergy').value, 0);
  const table = state.calibration.table || [];

  if (table.length < 2) {
    toast('นำเข้าตารางสอบเทียบที่แท็บ “สอบเทียบ” ก่อนจำลอง');
    return;
  }

  try {
    const depths = state.energy.rows
      .map((row, index) => {
        const depth = row && row.depth !== null && row.depth !== '' ? Number(row.depth) : NaN;
        return Number.isFinite(depth) ? depth : STANDARD_DEPTHS[index] ?? null;
      })
      .filter((depth) => depth !== null);

    const simulation = simulateDepthDose({ energy, depths, table, ao: 0, thickness: 1 });

    state.energy.rows = simulation.rows;
    save();
    activateTab('energy');
    renderEnergyTable();
    updateEnergyUI();

    const result = computeEnergy({
      rows: state.energy.rows,
      ao: 0,
      thickness: 1,
      correction: 1,
      table,
      autoFit: false,
      fitFrom: state.energy.fitFrom,
      fitTo: state.energy.fitTo,
    });

    if (result.error) {
      toast(`จำลอง ${energy} MeV แล้ว แต่ยังคำนวณไม่ได้: ${result.error}`);
    } else {
      toast(`จำลอง ${energy} MeV → Ea ${result.ea.toFixed(2)} · Ep ${result.ep.toFixed(2)} MeV`);
    }
  } catch (err) {
    toast(`จำลองไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

function bindEnergy() {
  $('btnSimRun').addEventListener('click', runEnergySimulation);
  $('chkEnergyAutoFit').addEventListener('change', (event) => {
    state.energy.autoFit = event.target.checked;
    $('energyFitFields').hidden = event.target.checked;
    save();
    computeEnergyUI();
  });
  $('inpEnergyFitFrom').addEventListener('input', (event) => {
    state.energy.fitFrom = num(event.target.value, 1);
    energyAnchor = null;
    save();
    computeEnergyUI();
  });
  $('inpEnergyFitTo').addEventListener('input', (event) => {
    state.energy.fitTo = num(event.target.value, 2);
    energyAnchor = null;
    save();
    computeEnergyUI();
  });

  $('btnEnergyAdd').addEventListener('click', () => addEnergyRows(6));
  $('btnEnergyClear').addEventListener('click', clearEnergyRows);
  $('btnEnergyCapture').addEventListener('click', captureLatestToEnergy);
  $('btnEnergyCsv').addEventListener('click', exportEnergyCsv);
}

/* ------------------------------------------------------------------ */
/* reports                                                             */
/* ------------------------------------------------------------------ */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentEnergyReport() {
  const result = lastEnergyResult;
  if (!result || result.error || !result.fit || result.r2 === null) return null;

  const rows = result.rows
    .filter((row) => row.depth !== null && row.ai !== null && row.ai !== '' && row.adjusted !== null)
    .map((row, index) => ({ no: index + 1, depth: row.depth, ai: row.ai, dose: row.adjusted }));

  if (rows.length < 2) return null;

  return {
    unit: state.settings.doseUnit || 'kGy',
    dmax: result.dmax,
    r50: result.r50,
    rp: result.rp,
    ea: result.ea,
    ep: result.ep,
    fit: {
      from: result.range ? result.range.from : null,
      to: result.range ? result.range.to : null,
      n: result.fit.n,
      slope: result.fit.slope,
      r2: result.r2,
      auto: state.energy.autoFit !== false,
    },
    rows,
  };
}

function activeReportMode() {
  const panel = document.querySelector('.tab-panel.is-active');
  return panel && panel.dataset.panel === 'energy' ? 'energy' : 'readings';
}

function reportModelFor(mode) {
  return buildReportModel({
    readings: mode === 'energy' ? [] : state.readings,
    calibration: state.calibration,
    settings: state.settings,
    doseOf,
    absOf: (reading) => toAbsorbance(reading.value, reading.unit),
    energy: mode === 'energy' ? currentEnergyReport() : null,
  });
}

function energyChartImage(width = 1100, height = 340) {
  const result = lastEnergyResult;
  if (!result || !result.fit) return '';

  const points = result.rows
    .filter((row) => row.depth !== null && row.adjusted !== null)
    .map((row) => ({ x: row.depth, y: row.adjusted }));
  if (points.length < 2) return '';

  const canvas = document.createElement('canvas');
  drawDepthDoseChart(canvas, points, {
    width,
    height,
    unit: state.settings.doseUnit,
    fit: result.fit,
    markers:
      result.r50 !== null && result.dmax !== null
        ? { r50: result.r50, rp: result.rp, dmax: result.dmax }
        : null,
  });

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

function exportExcel() {
  const mode = activeReportMode();
  const model = reportModelFor(mode);

  if (mode === 'energy' && !model.energy) {
    toast('ยังไม่มีข้อมูลวัดพลังงานให้ทำรายงาน');
    return;
  }
  if (mode === 'readings' && state.readings.length === 0) {
    toast('ยังไม่มีข้อมูลให้ทำรายงาน');
    return;
  }

  try {
    const images = {};
    if (mode === 'energy') {
      const image = energyChartImage(900, 280);
      if (image) images.energy = image;
    } else {
      const doseValues = state.readings
        .map((reading) => doseOf(reading))
        .filter((value) => value !== null && Number.isFinite(value))
        .slice(-120);
      const image = chartImageFor(doseValues, {
        width: 900,
        height: 260,
        color: '#b45309',
        fillColor: 'rgba(180, 83, 9, 0.10)',
      });
      if (image) images.readings = image;
    }

    const bytes = buildXlsx(buildReportWorkbook(model, images));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadBlob(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      mode === 'energy' ? `dose-report-energy-${stamp}.xlsx` : `dose-report-${stamp}.xlsx`,
    );
    toast(mode === 'energy' ? 'สร้างไฟล์ Excel (ชีต Energy) แล้ว' : 'สร้างไฟล์ Excel แล้ว');
  } catch (err) {
    toast(`สร้าง Excel ไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

function chartImageFor(values, style = {}) {
  if (!values || values.length < 2) return '';
  const canvas = document.createElement('canvas');
  drawLineChart(canvas, values, { width: 1100, height: 320, ...style });
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

function buildReportCharts() {
  const charts = [];
  let note = '';

  // รายงานใช้เฉพาะกราฟโดส (ไม่แสดงกราฟ absorbance)
  const doseValues = state.readings
    .map((reading) => doseOf(reading))
    .filter((value) => value !== null && Number.isFinite(value))
    .slice(-120);

  const doseImage = chartImageFor(doseValues, { color: '#b45309', fillColor: 'rgba(180, 83, 9, 0.10)' });
  if (doseImage) {
    const source = state.calibration.mode === 'table' ? 'จากตารางสอบเทียบ' : 'จากสูตร k₁/k₂';
    charts.push({
      src: doseImage,
      color: '#b45309',
      fillColor: 'rgba(180, 83, 9, 0.10)',
      caption: `กราฟแนวโน้มค่าโดส (${state.settings.doseUnit}) — ${source}`,
    });
  } else if (doseValues.length < 2) {
    note = 'ยังไม่มีกราฟโดส — ต้องเปิดใช้เส้นสอบเทียบและมีค่าที่อ่านได้อย่างน้อย 2 ค่า';
  }

  return { charts, note };
}

function exportPdf() {
  const mode = activeReportMode();
  const model = reportModelFor(mode);

  if (mode === 'energy' && !model.energy) {
    toast('ยังไม่มีข้อมูลวัดพลังงานให้ทำรายงาน');
    return;
  }
  if (mode === 'readings' && state.readings.length === 0) {
    toast('ยังไม่มีข้อมูลให้ทำรายงาน');
    return;
  }

  try {
    if (mode === 'energy') {
      renderPrintReport(model, $('printReport'), { charts: [], note: '', energyChart: energyChartImage() });
    } else {
      const { charts, note } = buildReportCharts();
      renderPrintReport(model, $('printReport'), { charts, note });
    }
    window.print();
  } catch (err) {
    toast(`สร้างรายงานไม่สำเร็จ: ${err && err.message ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function initModes() {
  const select = $('selMode');
  select.replaceChildren();
  for (const mode of MODES) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.label;
    select.appendChild(option);
  }
}

function restoreControls() {
  const s = state.settings;
  const c = state.calibration;

  $('selBaud').value = String(s.baudRate);
  $('selDataBits').value = String(s.dataBits);
  $('selStopBits').value = String(s.stopBits);
  $('selParity').value = s.parity;
  $('selFlow').value = s.flowControl;
  $('selMode').value = s.mode;
  $('inpRegex').value = s.regex;
  $('selLineEnding').value = s.lineEnding;
  $('inpCommand').value = s.command || 'SND';
  $('selDoseUnit').value = s.doseUnit;
  $('selMetric').value = s.metric;
  $('chkHex').checked = Boolean(s.hexRaw);
  $('inpPollSec').value = String(s.pollSec);

  $('chkCalib').checked = Boolean(c.enabled);
  $('inpA0').value = String(c.a0);
  $('inpK1').value = String(c.k1);
  $('inpK2').value = String(c.k2);
  $('selCalMode').value = c.mode === 'table' ? 'table' : 'formula';

  $('regexField').hidden = s.mode !== 'custom';
}

function bindSettings() {
  const s = state.settings;

  $('selBaud').addEventListener('change', (e) => { s.baudRate = Number(e.target.value); save(); });
  $('selDataBits').addEventListener('change', (e) => { s.dataBits = Number(e.target.value); save(); });
  $('selStopBits').addEventListener('change', (e) => { s.stopBits = Number(e.target.value); save(); });
  $('selParity').addEventListener('change', (e) => { s.parity = e.target.value; save(); });
  $('selFlow').addEventListener('change', (e) => { s.flowControl = e.target.value; save(); });

  $('selMode').addEventListener('change', (e) => {
    s.mode = e.target.value;
    $('regexField').hidden = s.mode !== 'custom';
    save();
    updateTest();
  });

  $('inpRegex').addEventListener('input', (e) => { s.regex = e.target.value; save(); updateTest(); });
  $('testLine').addEventListener('input', updateTest);

  $('selLineEnding').addEventListener('change', (e) => { s.lineEnding = e.target.value; save(); });
  $('inpCommand').addEventListener('input', (e) => { s.command = e.target.value; save(); });
  $('selDoseUnit').addEventListener('change', (e) => { s.doseUnit = e.target.value; save(); refreshDerived(); updateCalTest(); });

  $('selMetric').addEventListener('change', (e) => {
    s.metric = e.target.value;
    save();
    renderChart();
  });

  $('chkHex').addEventListener('change', (e) => {
    s.hexRaw = e.target.checked;
    rawLog = '';
    $('rawLog').textContent = '';
    save();
  });

  $('inpPollSec').addEventListener('change', (e) => {
    s.pollSec = num(e.target.value, 1);
    save();
    if (pollTimer) startPoll();
  });
}

function bindCalibration() {
  const c = state.calibration;

  $('chkCalib').addEventListener('change', (e) => {
    c.enabled = e.target.checked;
    save();
    refreshDerived();
  });

  $('selCalMode').addEventListener('change', (e) => {
    c.mode = e.target.value === 'table' ? 'table' : 'formula';
    save();
    updateCalibrationUI();
    refreshDerived();
  });

  $('btnImportCal').addEventListener('click', () => $('inpCalFile').click());
  $('btnImportCalTop').addEventListener('click', () => $('inpCalFile').click());
  $('inpCalTest').addEventListener('input', updateCalTest);
  $('inpCalFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) void importCalibration(file);
  });
  $('btnClearCal').addEventListener('click', () => {
    if (!state.calibration.table.length) return;
    if (!window.confirm('ล้างตารางสอบเทียบที่นำเข้าไว้?')) return;
    state.calibration.table = [];
    state.calibration.tableName = '';
    save();
    updateCalibrationUI();
    refreshDerived();
    toast('ล้างตารางสอบเทียบแล้ว');
  });

  $('inpA0').addEventListener('input', (e) => {
    c.a0 = num(e.target.value, 0);
    save();
    refreshDerived();
  });

  $('inpK1').addEventListener('input', (e) => {
    c.k1 = num(e.target.value, 0);
    save();
    refreshDerived();
  });

  $('inpK2').addEventListener('input', (e) => {
    c.k2 = num(e.target.value, 0);
    save();
    refreshDerived();
  });

  $('btnSetA0').addEventListener('click', () => {
    const r = lastReading();
    if (!r) {
      toast('ยังไม่มีค่าที่อ่านได้');
      return;
    }
    const abs = toAbsorbance(r.value, r.unit);
    if (abs === null) {
      toast('ค่าล่าสุดแปลงเป็น absorbance ไม่ได้');
      return;
    }
    c.a0 = abs;
    $('inpA0').value = abs.toFixed(4);
    save();
    refreshDerived();
    toast(`ตั้ง A₀ = ${abs.toFixed(4)}`);
  });
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  });

  const energyMode = name === 'energy';
  const title = $('chartTitle');
  if (title) title.textContent = energyMode ? 'กราฟ depth–dose' : 'แนวโน้ม';
  const metric = $('selMetric');
  if (metric) metric.hidden = energyMode;

  const readingsView = $('readingsView');
  const energyView = $('energyView');
  if (readingsView) readingsView.hidden = energyMode;
  if (energyView) energyView.hidden = !energyMode;

  const rightPane = document.querySelector('.col-right');
  if (rightPane) rightPane.classList.toggle('energy-mode', energyMode);

  const layout = document.querySelector('.layout');
  if (layout) {
    layout.classList.toggle('mode-reading', name === 'reading');
    layout.classList.toggle('mode-solo', name === 'connect' || name === 'cal');
  }

  requestAnimationFrame(() => {
    renderChart();
    if (name === 'reading') {
      scrollReadingsToLatest();
      setTimeout(scrollReadingsToLatest, 60);
    }
  });
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
}

function bindActions() {
  bindTabs();
  bindEnergy();
  $('btnConnect').addEventListener('click', connectSerial);
  $('btnDisconnect').addEventListener('click', disconnectSerial);
  $('btnDemo').addEventListener('click', toggleDemo);
  $('btnSend').addEventListener('click', sendCommand);
  $('btnSndTop').addEventListener('click', readNow);
  $('btnReportXlsx').addEventListener('click', exportExcel);
  $('btnReportPdf').addEventListener('click', exportPdf);
  $('btnCmdModel').addEventListener('click', () => sendPreset('MODEL'));
  $('btnCmdRev').addEventListener('click', () => sendPreset('REV'));
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', clearAll);
  $('btnPickPort').addEventListener('click', pickPort);
  $('btnRefreshPorts').addEventListener('click', () => { refreshPorts(); });
  $('selPort').addEventListener('change', (event) => {
    selectedPortIndex = event.target.value === '' ? -1 : Number(event.target.value);
    rememberPort();
  });
  $('btnClearRaw').addEventListener('click', () => {
    rawLog = '';
    $('rawLog').textContent = '';
    ignoredLines = 0;
    $('ignoredHits').textContent = 'บรรทัดที่แยกค่าไม่ได้: 0';
  });

  $('inpCommand').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    }
  });

  $('chkPoll').addEventListener('change', (e) => {    if (e.target.checked) {
      if (!session.port) {
        toast('เชื่อมต่อพอร์ตก่อน');
        e.target.checked = false;
        return;
      }
      startPoll();
    } else {
      stopPoll();
    }
  });

  $('rawDetails').addEventListener('toggle', () => {
    if ($('rawDetails').open) queueRawRender();
  });

  $('modalOk').addEventListener('click', closeReadingPopup);
  $('readingModal').addEventListener('click', (event) => {
    if (event.target === $('readingModal')) closeReadingPopup();
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (modalOpen) {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          closeReadingPopup();
        }
        return;
      }

      // --- คีย์ลัด Ctrl + Shift ซ้าย (กดสองปุ่มนี้แล้วปล่อย) ---
      if (event.key === 'Control') {
        ctrlDown = true;
        if (shiftLeftDown) armCtrlShift();
        return;
      }
      if (event.key === 'Shift' && event.code === 'ShiftLeft') {
        shiftLeftDown = true;
        if (ctrlDown) armCtrlShift();
        return;
      }

      // ปุ่มอื่นถูกกดระหว่างถือ Ctrl+Shift → ยกเลิก (กัน Ctrl+Shift+R ฯลฯ ไปสั่งอ่านค่า)
      if (shiftPending) cancelCtrlShift();

      // เผื่อไว้: Ctrl+Shift+ลูกศรซ้าย ก็ยังใช้ได้
      const isLeftArrow = event.key === 'ArrowLeft' || event.code === 'ArrowLeft';
      if (ctrlDown && shiftLeftDown && isLeftArrow) {
        event.preventDefault();
        event.stopPropagation();
        fireShortcutRead();
      }
    },
    true,
  );

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Control') {
        ctrlDown = false;
        if (!shiftLeftDown) maybeFireCtrlShift();
        return;
      }
      if (event.code === 'ShiftLeft') {
        shiftLeftDown = false;
        maybeFireCtrlShift();
      }
    },
    true,
  );

  window.addEventListener('beforeunload', () => {
    if (session.port) {
      try {
        session.disconnect();
      } catch {
        /* ignore */
      }
    }
  });
}

function init() {
  initModes();
  restoreControls();
  bindSettings();
  bindCalibration();
  bindActions();

  if (!SerialSession.supported) {
    $('btnConnect').disabled = true;
    $('btnConnect').title = 'เบราว์เซอร์ไม่รองรับ Web Serial';
    setStatus('error', 'เบราว์เซอร์ไม่รองรับ Web Serial');
    toast('เปิดหน้านี้ด้วย Chrome/Edge บน localhost หรือ HTTPS เพื่อใช้พอร์ตอนุกรม');
  } else {
    setStatus('idle', 'ยังไม่เชื่อมต่อ');
  }

  setConnectedUI(false);
  void initPorts();
  updateCalibrationUI();
  renderEnergyTable();
  updateEnergyUI();

  updateTest();
  renderCurrent();
  renderStats();
  renderTable();
  renderChart();

  const ro = new ResizeObserver(() => {
    requestAnimationFrame(renderChart);
  });
  ro.observe($('chart').parentElement);

  if (state.readings.length) {
    toast(`กู้คืนข้อมูลเดิม ${state.readings.length} รายการ`);
  }
}

init();
