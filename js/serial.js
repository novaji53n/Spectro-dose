/**
 * ตัวจัดการพอร์ตอนุกรมผ่าน Web Serial API (Chrome/Edge)
 * - อ่านข้อมูลเป็นข้อความและแบ่งเป็น "บรรทัด" ให้อัตโนมัติ
 * - รองรับเครื่องที่ส่งข้อมูลมาโดยไม่มีอักขระขึ้นบรรทัดใหม่ (flush เมื่อเงียบ 600 ms)
 * - ส่งคำสั่งกลับไปยังเครื่องได้
 */

const LINE_BREAK = /\r\n|\n|\r/;
const IDLE_FLUSH_MS = 600;
const MAX_BUFFER = 8192;

export class SerialSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.decoder = null;
    this.buffer = '';
    this.idleTimer = 0;
    this.closing = false;
    this.loopPromise = null;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /**
   * เปิดพอร์ต
   * @param {SerialOptions} options
   * @param {SerialPort|null} existingPort พอร์ตที่ผู้ใช้เลือกไว้แล้ว (ถ้าไม่ส่ง จะเปิด chooser ให้เลือก)
   */
  async connect(options, existingPort = null) {
    if (!SerialSession.supported) {
      const err = new Error('เบราว์เซอร์นี้ไม่รองรับ Web Serial (ใช้ Chrome/Edge)');
      err.name = 'NotSupportedError';
      throw err;
    }
    if (this.port) throw new Error('เชื่อมต่ออยู่แล้ว');

    this.port = existingPort || (await navigator.serial.requestPort());
    try {
      await this.port.open(options);
    } catch (err) {
      this.port = null;
      throw err;
    }

    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.writer = this.port.writable.getWriter();
    this.buffer = '';
    this.closing = false;
    this.handlers.onStatus?.('open', this.port.getInfo?.() ?? {});
    this.loopPromise = this.readLoop();
  }

  async readLoop() {
    try {
      this.reader = this.port.readable.getReader();
    } catch (err) {
      this.handlers.onError?.(err);
      return;
    }

    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        this.handlers.onRaw?.(value);
        this.push(this.decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!this.closing) this.handlers.onError?.(err);
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        /* already released */
      }
      this.reader = null;

      // เครื่องถูกถอดสาย / ปิดสตรีมเอง: เก็บกวาดให้เรียบร้อยแล้วแจ้ง UI
      if (!this.closing) {
        this.closing = true;
        try {
          this.writer?.releaseLock();
        } catch {
          /* ignore */
        }
        this.writer = null;
        const port = this.port;
        this.port = null;
        try {
          await port?.close();
        } catch {
          /* ignore */
        }
        this.handlers.onStatus?.('closed');
      }
    }
  }

  push(text) {
    if (!text) return;
    this.buffer += text;

    const parts = this.buffer.split(LINE_BREAK);
    if (parts.length > 1) {
      this.buffer = parts.pop() ?? '';
      for (const part of parts) this.emit(part);
    }

    if (this.buffer.length > MAX_BUFFER) {
      const overflow = this.buffer;
      this.buffer = '';
      this.emit(overflow);
    }

    clearTimeout(this.idleTimer);
    if (this.buffer.trim()) {
      this.idleTimer = setTimeout(() => {
        const pending = this.buffer;
        this.buffer = '';
        if (pending.trim()) this.emit(pending);
      }, IDLE_FLUSH_MS);
    }
  }

  emit(line) {
    const text = line.replace(/\r/g, '').trim();
    if (!text) return;
    this.handlers.onLine?.(text);
  }

  /** ส่งข้อความไปยังเครื่อง */
  async send(text, lineEnding = 'CRLF') {
    if (!this.writer) throw new Error('ยังไม่ได้เชื่อมต่อพอร์ต');
    const map = { CRLF: '\r\n', LF: '\n', CR: '\r', NONE: '' };
    const payload = String(text) + (map[lineEnding] ?? '\r\n');
    await this.writer.write(new TextEncoder().encode(payload));
  }

  async disconnect() {
    this.closing = true;
    clearTimeout(this.idleTimer);

    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.loopPromise;
    } catch {
      /* ignore */
    }

    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    this.writer = null;

    const port = this.port;
    this.port = null;

    try {
      await port?.close();
    } catch {
      /* ignore */
    }

    this.handlers.onStatus?.('closed');
  }
}
