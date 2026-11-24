import assert from 'node:assert/strict';
import test from 'node:test';
import { BUDS_SERVICES, GalaxyBudsTracker, crc16, makePacket } from '../../web/joc/galaxy-buds.mjs';

test('Galaxy Buds protocol framing uses CRC-16/XMODEM and expected service UUIDs', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
  assert.deepEqual(BUDS_SERVICES, ['2e73a4ad-332d-41fc-90e2-16bef06523f2', '00001101-0000-1000-8000-00805f9b34fb']);
  const packet = makePacket(124, [1]);
  assert.deepEqual([...packet], [0xfd, 4, 0, 124, 1, 0x15, 0x5d, 0xdd]);
});

test('tracker accepts fragmented quaternion packets, recenters and ignores corrupt CRCs', () => {
  const poses = [];
  const tracker = new GalaxyBudsTracker({ onPose: (pose) => poses.push(pose) });
  const payload = [32, 0, 0, 0, 0, 0, 0, 0x10, 0x27];
  const packet = makePacket(194, payload);
  tracker.feed(packet.slice(0, 4));
  assert.equal(poses.length, 0);
  tracker.feed(packet.slice(4));
  assert.equal(poses.length, 1);
  assert.deepEqual(poses[0], { yaw: 0, pitch: 0, roll: 0 });

  const corrupt = makePacket(194, payload);
  corrupt[corrupt.length - 2] ^= 0xff;
  tracker.feed(corrupt);
  assert.equal(poses.length, 1);
  tracker.recenter();
  assert.deepEqual(poses.at(-1), { yaw: 0, pitch: 0, roll: 0 });
});

test('Buds yaw mapping uses the corrected scene direction', () => {
  const poses = [];
  const tracker = new GalaxyBudsTracker({ onPose: (pose) => poses.push(pose) });
  const packetFor = (y, w) => makePacket(194, [32, 0, 0, y & 0xff, (y >> 8) & 0xff, 0, 0, w & 0xff, (w >> 8) & 0xff]);
  tracker.feed(packetFor(0, 10000));
  tracker.feed(packetFor(2474, 9689));
  assert.ok(poses[1].yaw < 0, `expected corrected yaw sign, got ${poses[1].yaw}`);
});

test('each tracker type requests exactly one Bluetooth service to avoid duplicate devices', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'serial');
  let options;
  Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    requestPort: async (request) => { options = request; throw new DOMException('Cancelled', 'NotFoundError'); },
  } });
  try {
    for (const service of BUDS_SERVICES) {
      const tracker = new GalaxyBudsTracker();
      await assert.rejects(tracker.connect(service), { name: 'NotFoundError' });
      assert.deepEqual(options, {
        allowedBluetoothServiceClassIds: [service],
        filters: [{ bluetoothServiceClassId: service }],
      });
    }
  } finally {
    if (original) Object.defineProperty(navigator, 'serial', original);
    else delete navigator.serial;
  }
});
