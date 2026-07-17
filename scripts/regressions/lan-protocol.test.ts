import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeLanDeviceKey,
  isLanControlMessage,
  parseLanDeviceKey,
  type LanDeviceKeyEnvelope,
} from '../../apps/web/src/lan/protocol';

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
