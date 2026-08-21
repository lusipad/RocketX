import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  playNotificationSound,
  resetNotificationSoundForTests,
} from '../../apps/web/src/lib/notificationSound';

/** WebAudio 的最小 mock：只记录我们关心的调用（振荡器调度、增益包络、resume） */
class MockOscillatorNode {
  type = '';
  frequency = { value: 0 };
  startedAt: number[] = [];
  stoppedAt: number[] = [];
  connectedTo: unknown = null;

  connect(node: unknown): void {
    this.connectedTo = node;
  }

  start(at: number): void {
    this.startedAt.push(at);
  }

  stop(at: number): void {
    this.stoppedAt.push(at);
  }
}

class MockGainNode {
  gain = {
    setValues: [] as Array<[number, number]>,
    linearRamps: [] as Array<[number, number]>,
    exponentialRamps: [] as Array<[number, number]>,
    setValueAtTime(value: number, at: number): void {
      this.setValues.push([value, at]);
    },
    linearRampToValueAtTime(value: number, at: number): void {
      this.linearRamps.push([value, at]);
    },
    exponentialRampToValueAtTime(value: number, at: number): void {
      this.exponentialRamps.push([value, at]);
    },
  };

  connectedTo: unknown = null;

  connect(node: unknown): void {
    this.connectedTo = node;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];

  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 1;
  destination = { kind: 'destination' };
  resumeCalls = 0;
  resumeShouldReject = false;
  oscillators: MockOscillatorNode[] = [];
  gains: MockGainNode[] = [];

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createOscillator(): MockOscillatorNode {
    const node = new MockOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createGain(): MockGainNode {
    const node = new MockGainNode();
    this.gains.push(node);
    return node;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return this.resumeShouldReject
      ? Promise.reject(new Error('autoplay denied'))
      : Promise.resolve();
  }
}

function installMockAudioContext(): void {
  MockAudioContext.instances = [];
  resetNotificationSoundForTests();
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
}

function uninstallMockAudioContext(): void {
  resetNotificationSoundForTests();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
}

test('弹通知分支发声：合成一次短促提示音，增益峰值跟随音量设置', () => {
  installMockAudioContext();
  try {
    playNotificationSound(50);
    assert.equal(MockAudioContext.instances.length, 1, '复用单个 AudioContext');
    const ctx = MockAudioContext.instances[0];
    assert.equal(ctx.oscillators.length, 1);
    assert.equal(ctx.oscillators[0].startedAt.length, 1, '振荡器已调度');
    assert.equal(ctx.oscillators[0].stoppedAt.length, 1, '短音要有收尾 stop');
    const gain = ctx.gains[0];
    assert.deepEqual(gain.gain.linearRamps.map(([value]) => value), [0.5], '峰值 = 音量 50%');
    assert.ok(gain.gain.exponentialRamps.length > 0, '有衰减收尾防爆音');
    assert.equal(gain.connectedTo, ctx.destination, '增益节点接到输出');
  } finally {
    uninstallMockAudioContext();
  }
});

test('再次播放复用同一个 AudioContext，音量变化反映在新一次的增益上', () => {
  installMockAudioContext();
  try {
    playNotificationSound(100);
    playNotificationSound(20);
    assert.equal(MockAudioContext.instances.length, 1);
    const ctx = MockAudioContext.instances[0];
    assert.deepEqual(
      ctx.gains.map((node) => node.gain.linearRamps[0][0]),
      [1, 0.2],
    );
  } finally {
    uninstallMockAudioContext();
  }
});

test('音量为 0（通知被静音）时完全不碰 AudioContext', () => {
  installMockAudioContext();
  try {
    playNotificationSound(0);
    assert.equal(MockAudioContext.instances.length, 0, '不构造 AudioContext 自然不出声');
  } finally {
    uninstallMockAudioContext();
  }
});

test('超出 0-100 的音量被钳制，非法值按满音量兜底', () => {
  installMockAudioContext();
  try {
    playNotificationSound(500);
    playNotificationSound(undefined);
    const ctx = MockAudioContext.instances[0];
    assert.deepEqual(
      ctx.gains.map((node) => node.gain.linearRamps[0][0]),
      [1, 1],
    );
  } finally {
    uninstallMockAudioContext();
  }
});

test('AudioContext suspended（首次交互前的自动播放限制）时容错：resume 被拒也不抛错', async () => {
  MockAudioContext.instances = [];
  resetNotificationSoundForTests();
  // 造出来的 context 直接处于 suspended 且 resume 被拒——模拟首次用户交互前
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: class extends MockAudioContext {
      constructor() {
        super();
        this.state = 'suspended';
        this.resumeShouldReject = true;
      }
    },
  });
  try {
    assert.doesNotThrow(() => playNotificationSound(80));
    const used = MockAudioContext.instances[0];
    assert.equal(used.state, 'suspended');
    assert.equal(used.resumeCalls, 1, 'suspended 时尝试 resume');
    assert.equal(used.oscillators.length, 1, '声音照常调度（手势落地后出声），不中断通知链路');
    // resume 的拒绝是异步的：等一拍确认没有未处理的 rejection 炸掉测试进程
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    uninstallMockAudioContext();
  }
});

test('没有 WebAudio 的环境（老 WebView / node）静默返回', () => {
  uninstallMockAudioContext();
  assert.doesNotThrow(() => playNotificationSound(100));
});

test('提示音只在真正弹通知的分支之后发声（chat.ts 路由顺序锁定）', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );
  const policyReturn = source.indexOf('if (!policy.showDesktopNotification) return;');
  const aggregateRoute = source.indexOf("routeNotification(candidate, routeConfig).mode === 'aggregate'");
  const soundCall = source.indexOf('playNotificationSound(');
  assert.ok(policyReturn >= 0, '通知策略抑制分支必须存在');
  assert.ok(aggregateRoute >= 0, '聚合路由分支必须存在');
  assert.ok(soundCall > policyReturn, '提示音必须在策略抑制 return 之后——被抑制时不发声');
  assert.ok(soundCall > aggregateRoute, '提示音必须在聚合路由之后——进聚合桶的消息不发声');
  assert.ok(
    source.includes('if (shown) playNotificationSound('),
    '提示音跟着 desktopNotify 的 shown 结果走——权限被拒不发声',
  );
});

test('聚合通知到期弹出时同样发声（MainPage 聚合 flush 锁定）', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/pages/MainPage.tsx', import.meta.url),
    'utf8',
  );
  const flushIndex = source.indexOf('flushDue(Date.now())');
  const soundCall = source.indexOf('playNotificationSound(');
  assert.ok(flushIndex >= 0 && soundCall > flushIndex, '聚合 flush 的通知也要按音量发声');
});
