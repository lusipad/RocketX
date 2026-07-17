import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeLanDeviceKey,
  isLanControlMessage,
  parseLanDeviceKey,
  type LanDeviceKeyEnvelope,
} from '../../apps/web/src/lan/protocol';
import { redactedLanPeers } from '../../apps/web/src/lan/runtime';

const envelope: LanDeviceKeyEnvelope = {
  version: 1,
  userId: 'alice-user-id',
  deviceId: 'alice-device-id',
  deviceName: 'Alice 的工作站',
  publicKey: 'A'.repeat(43),
};

test('LAN 设备公钥控制消息可往返且不会丢失中文设备名', () => {
  const encoded = encodeLanDeviceKey(envelope);
  assert.equal(isLanControlMessage(encoded), true);
  assert.deepEqual(parseLanDeviceKey(encoded), envelope);
});

test('LAN 设备公钥控制消息拒绝控制字符和损坏载荷', () => {
  const damaged = encodeLanDeviceKey(envelope).replace(/.$/, '!');
  assert.equal(parseLanDeviceKey(damaged), null);
  assert.equal(
    parseLanDeviceKey(encodeLanDeviceKey({ ...envelope, deviceName: 'bad\ndevice' })),
    null,
  );
  assert.equal(parseLanDeviceKey('[RocketX-LAN-KEY:v1] not-base64'), null);
});

test('应用发现能力不会泄露局域网地址、端口或设备公钥', () => {
  const [peer] = redactedLanPeers([
    {
      userId: 'alice',
      deviceId: 'device-a',
      deviceName: 'Alice PC',
      ip: '192.168.1.8',
      port: 45826,
      publicKey: 'secret-public-key',
      trusted: true,
      source: 'mdns',
      lastSeenMs: 123,
    },
  ]);
  assert.deepEqual(peer, {
    userId: 'alice',
    deviceId: 'device-a',
    deviceName: 'Alice PC',
    trusted: true,
    source: 'mdns',
    lastSeenMs: 123,
  });
  assert.equal('ip' in peer, false);
  assert.equal('port' in peer, false);
  assert.equal('publicKey' in peer, false);
});
