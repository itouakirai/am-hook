/* Samsung Galaxy Buds spatial-head tracking over the Web Serial Bluetooth bridge. */
export const BUDS_SERVICES = Object.freeze([
  '2e73a4ad-332d-41fc-90e2-16bef06523f2', // Buds2 Pro / Buds3 Pro
  '00001101-0000-1000-8000-00805f9b34fb', // Buds Pro (SPP)
]);

const MSG_SET_SPATIAL = 124;
const MSG_SPATIAL_DATA = 194;
const MSG_SPATIAL_CTRL = 195;

export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function makePacket(id, payload = []) {
  const size = 1 + payload.length + 2;
  const body = [id, ...payload];
  const crc = crc16(body);
  return new Uint8Array([0xfd, size & 0xff, (size >> 8) & 3, ...body, crc & 0xff, crc >> 8, 0xdd]);
}

function multiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function inverse(q) {
  const norm = q.reduce((sum, value) => sum + value * value, 0) || 1;
  return [-q[0] / norm, -q[1] / norm, -q[2] / norm, q[3] / norm];
}

function orientation(raw, reference) {
  let q = multiply(raw, inverse(reference));
  const norm = Math.hypot(...q) || 1;
  q = q.map((value) => value / norm);
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + y * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m23 = 2 * (y * z - x * w);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m11 = 1 - 2 * (y * y + z * z);
  const m31 = 2 * (x * z - y * w);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m23)));
  const roll = Math.abs(m23) < 0.9999 ? Math.atan2(m21, m22) : 0;
  const yaw = -(Math.abs(m23) < 0.9999 ? Math.atan2(m13, m33) : Math.atan2(-m31, m11));
  // Match the reference viewer's default yaw/pitch direction and retain its roll direction.
  return { yaw: yaw || 0, pitch: pitch ? -pitch : 0, roll: roll || 0 };
}

/** Owns the serial port, protocol stream and head-orientation reference. */
export class GalaxyBudsTracker {
  constructor({ onPose = () => {}, onStatus = () => {} } = {}) {
    this.onPose = onPose;
    this.onStatus = onStatus;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.keepAlive = null;
    this.rx = [];
    this.reference = null;
    this.last = null;
    this.stopping = false;
  }

  async connect(service = BUDS_SERVICES[0]) {
    if (this.port) return;
    if (!navigator.serial) throw new Error('Web Serial is unavailable in this browser');
    if (!BUDS_SERVICES.includes(service)) throw new Error('Unknown Galaxy Buds service');
    const port = await navigator.serial.requestPort({
      allowedBluetoothServiceClassIds: [service],
      filters: [{ bluetoothServiceClassId: service }],
    });
    this.port = port;
    try {
      await port.open({ baudRate: 9600 });
      this.writer = port.writable.getWriter();
      this.stopping = false;
      this.rx = [];
      this.reference = null;
      this.last = null;
      await this.send(MSG_SET_SPATIAL, [1]);
      await this.send(MSG_SPATIAL_CTRL, [0]);
      this.keepAlive = setInterval(() => { this.send(MSG_SPATIAL_CTRL, [4]).catch(() => {}); }, 2000);
      this.onStatus('connected');
      this.readLoop(port);
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async send(id, payload) {
    if (!this.writer) throw new Error('Galaxy Buds are disconnected');
    await this.writer.write(makePacket(id, payload));
  }

  async readLoop(port) {
    try {
      this.reader = port.readable.getReader();
      while (!this.stopping) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.feed(value);
      }
    } catch (error) {
      if (!this.stopping) this.onStatus(`error: ${error.message || error}`);
    } finally {
      if (!this.stopping && this.port === port) {
        await this.cleanup();
        this.onStatus('disconnected');
      }
    }
  }

  feed(chunk) {
    for (const byte of chunk) this.rx.push(byte);
    while (this.rx.length) {
      const start = this.rx.indexOf(0xfd);
      if (start < 0) { this.rx.length = 0; return; }
      if (start) this.rx.splice(0, start);
      if (this.rx.length < 3) return;
      const size = ((this.rx[2] << 8) | this.rx[1]) & 0x3ff;
      const total = 3 + size + 1;
      if (this.rx.length < total) return;
      const packet = this.rx.splice(0, total);
      if (packet[total - 1] !== 0xdd) continue;
      const body = packet.slice(3, total - 3);
      const expected = crc16(body);
      const actual = packet[total - 3] | (packet[total - 2] << 8);
      if (expected !== actual || body[0] !== MSG_SPATIAL_DATA || body[1] !== 32 || body.length < 10) continue;
      const view = new DataView(new Uint8Array(body.slice(1)).buffer);
      const q = [0, 1, 2, 3].map((index) => view.getInt16(1 + index * 2, true) / 10000);
      const norm = Math.hypot(...q);
      if (!Number.isFinite(norm) || norm < 0.5 || norm > 1.5) continue;
      this.last = q.map((value) => value / norm);
      if (!this.reference) this.reference = this.last;
      this.onPose(orientation(this.last, this.reference));
    }
  }

  recenter() {
    if (this.last) this.reference = this.last;
    this.onPose({ yaw: 0, pitch: 0, roll: 0 });
  }

  async disconnect() {
    if (!this.port) return;
    this.stopping = true;
    const port = this.port;
    try {
      if (this.writer) {
        await this.send(MSG_SPATIAL_CTRL, [1]);
        await this.send(MSG_SET_SPATIAL, [0]);
      }
    } catch { /* Port may already have disappeared. */ }
    if (this.reader) {
      try { await this.reader.cancel(); } catch { /* Already closed. */ }
    }
    await this.cleanup(port);
    this.onStatus('disconnected');
  }

  async cleanup(port = this.port) {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.reader) {
      try { this.reader.releaseLock(); } catch { /* Read loop may still be unwinding. */ }
      this.reader = null;
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* Port may have closed. */ }
      this.writer = null;
    }
    if (port) {
      try { await port.close(); } catch { /* Already closed. */ }
    }
    if (this.port === port) this.port = null;
  }
}
