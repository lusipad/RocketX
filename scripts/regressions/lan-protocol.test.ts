import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('局域网密钥不会通过 Rocket.Chat 消息发送，只在 P2P 操作时按需探测', () => {
  const runtime = readFileSync('apps/web/src/lan/runtime.ts', 'utf8');
  assert.doesNotMatch(runtime, /sendMessageRaw|handleLanControlMessage|ensureKeyExchange/);
  assert.match(runtime, /lan_probe_peer/);
  assert.match(runtime, /export async function probeLanPeer/);
  assert.match(runtime, /confirmLanUser\(result\.userId\)/);
});

test('旧版 LAN 控制消息不会进入实时流或历史消息列表', () => {
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const messageList = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  assert.match(chat, /if \(isLanControlMessage\(msg\.msg\)\) return;/);
  assert.match(chat, /history\.filter\(\(message\) => !isLanControlMessage\(message\.msg\)\)/);
  assert.match(chat, /const existing = \(get\(\)\.messages\[rid\] \?\? \[\]\)\.filter\(/);
  assert.match(chat, /if \(!isLanControlMessage\(m\.msg\)\) list = upsertMessage\(list, m\)/);
  assert.match(chat, /if \(!isLanControlMessage\(m\.msg\)\) merged = upsertMessage\(merged, m\)/);
  assert.match(messageList, /!isLanControlMessage\(message\.msg\)/);
});

test('点击 P2P 按钮时才执行一次 LAN 握手，不通过聊天消息交换密钥', () => {
  const runtime = readFileSync('apps/web/src/lan/runtime.ts', 'utf8');
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  assert.match(runtime, /const result = await invoke<TrustedDevice>\('lan_probe_peer'/);
  assert.match(runtime, /await pinTrustedDevice\(/);
  assert.doesNotMatch(runtime, /sendMessageRaw|handleLanControlMessage|ensureKeyExchange/);
  const sendP2p = chat.slice(chat.indexOf('sendP2pFiles:'), chat.indexOf('prepareP2p:'));
  assert.doesNotMatch(sendP2p, /probeLanPeer\(/);
  const startup = runtime.slice(runtime.indexOf('export async function startLanRuntime'), runtime.indexOf('export async function stopLanRuntime'));
  assert.doesNotMatch(startup, /lan_probe_peer|probeLanPeer\(/);
  assert.match(chat.slice(chat.indexOf('prepareP2p:'), chat.indexOf('\n}));')), /probeLanPeer\(/);
});

test('P2P 只从输入区显式触发，并在点击时执行握手（issue #368）', () => {
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const area = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');
  assert.match(chat, /prepareP2p: async/);
  assert.match(chat, /if \(!\(await probeLanPeer\(recipients\[0\]\)\)\)/);
  const sendP2p = chat.slice(chat.indexOf('sendP2pFiles:'), chat.indexOf('prepareP2p:'));
  assert.doesNotMatch(sendP2p, /probeLanPeer\(/);
  assert.match(readFileSync('apps/web/src/components/Composer.tsx', 'utf8'), /P2P 局域网直传/);
  assert.doesNotMatch(area, /confirmedLanUsers/);
});

test('LAN 发现同时提供组播和同网段广播兜底（issue #369）', () => {
  const discovery = readFileSync('apps/desktop/src-tauri/src/native/lan_discovery.rs', 'utf8');
  const lan = readFileSync('apps/desktop/src-tauri/src/lan.rs', 'utf8');
  assert.match(discovery, /UDP_BROADCAST: Ipv4Addr = Ipv4Addr::new\(255, 255, 255, 255\)/);
  assert.match(lan, /set_broadcast\(true\)/);
  assert.match(lan, /send_to\(&payload, multicast_destination\)/);
  assert.match(lan, /send_to\(&payload, broadcast_destination\)/);
});

test('LAN 发现优先保留 UDP 实际来源地址，避免 mDNS 虚拟网卡地址覆盖', () => {
  const lan = readFileSync('apps/desktop/src-tauri/src/lan.rs', 'utf8');
  assert.match(lan, /"udp" => 2/);
  assert.match(lan, /"mdns" => 1/);
  assert.match(lan, /不要让它覆盖已由 UDP/);
});
