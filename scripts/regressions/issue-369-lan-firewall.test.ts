import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  UNKNOWN_LAN_FIREWALL,
  lanFirewallAdvice,
  lanFirewallFailureHint,
  withLanFirewallGate,
  type LanFirewallState,
  type LanFirewallStatus,
} from '../../apps/web/src/lan/firewall';

/**
 * issue #369：原先启动时静默 `netsh add rule`，但程序以中完整性运行，netsh 必报
 * 「请求的操作需要提升」，放行从未生效；而 Windows「允许访问」弹窗被取消或由非管理员
 * 点击时生成的阻止规则优先于任何放行规则。
 *
 * 现在默认不碰防火墙、不要管理员权限：只在用户点击 P2P 直传时检查；确定被挡才请求
 * 一次 UAC；拿不准时先直传，失败了才请求授权并重试一次。
 */
const STATES: LanFirewallState[] = [
  'ok',
  'partial',
  'missing_rule',
  'blocked',
  'blocked_other',
  'block_all_inbound',
  'managed',
  'third_party',
  'unsupported',
  'unknown',
];

function status(state: LanFirewallState, extra: Partial<LanFirewallStatus> = {}): LanFirewallStatus {
  return { ...UNKNOWN_LAN_FIREWALL, state, scope: 'lan', profiles: ['private'], ...extra };
}

type Step = LanFirewallStatus | null | Error;

/** 按脚本回放检查/修复/直传的结果，并记录调用顺序。 */
function scripted(options: { check: LanFirewallStatus | Error; repairs?: Step[]; attempts: Array<'ok' | Error> }) {
  const log: string[] = [];
  const repairs = [...(options.repairs ?? [])];
  const attempts = [...options.attempts];
  return {
    log,
    deps: {
      check: async () => {
        log.push('check');
        if (options.check instanceof Error) throw options.check;
        return options.check;
      },
      repair: async () => {
        log.push('repair');
        const next = repairs.shift() ?? null;
        if (next instanceof Error) throw next;
        return next;
      },
      waitForPeer: async () => {
        log.push('wait');
      },
      attempt: async () => {
        log.push('attempt');
        const next = attempts.shift() ?? new Error('no more attempts');
        if (next instanceof Error) throw next;
        return next;
      },
      onElevate: (reason: string) => {
        log.push(`elevate:${reason}`);
      },
    },
  };
}

test('只有确定会挡住直传、且一键放行能修好的状态才在点击时请求授权', () => {
  const elevating = STATES.filter((state) => lanFirewallAdvice(status(state)).elevate);
  assert.deepEqual(elevating, ['missing_rule', 'blocked']);
  const breaking = STATES.filter((state) => lanFirewallAdvice(status(state)).breaksP2p);
  assert.deepEqual(breaking, ['missing_rule', 'blocked', 'blocked_other', 'block_all_inbound', 'managed']);
});

test('拿不准的情况只在直传失败后才请求授权', () => {
  const afterFailure = STATES.filter((state) => lanFirewallAdvice(status(state)).elevateOnFailure);
  assert.deepEqual(afterFailure, ['partial', 'unknown']);
  // 判为放行但有判定不了的阻止规则：同样失败后再请求。只有判定不了的放行规则则不必。
  assert.equal(lanFirewallAdvice(status('ok', { uncertainBlocks: 1, uncertainRules: 1 })).elevateOnFailure, true);
  assert.equal(lanFirewallAdvice(status('ok', { uncertainRules: 5 })).elevateOnFailure, false);
});

test('一键放行修不了的状态给出对应的处理方式，而不是弹 UAC', () => {
  assert.match(lanFirewallAdvice(status('block_all_inbound')).text, /阻止所有传入连接/);
  assert.match(lanFirewallAdvice(status('blocked_other')).text, /管理员检查/);
  assert.match(lanFirewallAdvice(status('managed')).text, /IT/);
  assert.match(
    lanFirewallAdvice(status('third_party', { thirdParty: ['火绒安全'] })).text,
    /「火绒安全」接管/,
  );
});

test('防火墙放行时点击 P2P 不请求授权，直接直传', async () => {
  const { log, deps } = scripted({ check: status('ok'), attempts: ['ok'] });
  await withLanFirewallGate(deps);
  assert.deepEqual(log, ['check', 'attempt']);
});

test('确定被挡时先请求授权、等对方公告到达，再直传（issue #369）', async () => {
  for (const state of ['blocked', 'missing_rule'] as const) {
    const { log, deps } = scripted({ check: status(state), repairs: [status('ok')], attempts: ['ok'] });
    await withLanFirewallGate(deps);
    assert.deepEqual(log, ['check', 'elevate:blocked', 'repair', 'wait', 'attempt'], state);
  }
});

test('用户拒绝授权时照常尝试直传，失败后不再重复弹 UAC', async () => {
  const { log, deps } = scripted({ check: status('blocked'), repairs: [null], attempts: [new Error('no LAN peer')] });
  await assert.rejects(withLanFirewallGate(deps), /no LAN peer/);
  assert.deepEqual(log, ['check', 'elevate:blocked', 'repair', 'attempt']);
});

test('拿不准时先直传，失败了才请求授权并重试一次', async () => {
  const { log, deps } = scripted({
    check: status('partial'),
    repairs: [status('ok')],
    attempts: [new Error('failed to connect LAN peer'), 'ok'],
  });
  await withLanFirewallGate(deps);
  assert.deepEqual(log, ['check', 'attempt', 'elevate:after_failure', 'repair', 'wait', 'attempt']);
});

test('读不到防火墙状态时不打扰用户；失败后才请求授权', async () => {
  const { log, deps } = scripted({
    check: new Error('COM failed'),
    repairs: [null],
    attempts: [new Error('failed to connect LAN peer')],
  });
  await assert.rejects(withLanFirewallGate(deps), /failed to connect LAN peer/);
  assert.deepEqual(log, ['check', 'attempt', 'elevate:after_failure', 'repair']);
});

test('授权后仍被挡或修复出错，都抛出原来的错误，不做无意义的重试', async () => {
  for (const repair of [status('blocked'), new Error('netsh exited 1')]) {
    const { log, deps } = scripted({
      check: status('partial'),
      repairs: [repair],
      attempts: [new Error('original failure')],
    });
    await assert.rejects(withLanFirewallGate(deps), /original failure/);
    assert.deepEqual(log, ['check', 'attempt', 'elevate:after_failure', 'repair']);
  }
});

test('修不了的状态不弹 UAC，直传失败后同样不弹', async () => {
  for (const state of ['managed', 'block_all_inbound', 'blocked_other', 'third_party'] as const) {
    const { log, deps } = scripted({ check: status(state), attempts: [new Error('fail')] });
    await assert.rejects(withLanFirewallGate(deps));
    assert.deepEqual(log, ['check', 'attempt'], state);
  }
});

test('失败提示：防火墙是原因时以它开头，第三方安全软件只作补充', () => {
  assert.equal(lanFirewallFailureHint(status('ok')), null);
  const blocked = lanFirewallFailureHint(status('blocked'));
  assert.equal(blocked?.cause, true);
  assert.match(blocked?.text ?? '', /允许管理员授权/);
  const managed = lanFirewallFailureHint(status('managed'));
  assert.equal(managed?.cause, true);
  assert.doesNotMatch(managed?.text ?? '', /允许管理员授权/);
  const thirdParty = lanFirewallFailureHint(status('ok', { thirdParty: ['360 安全卫士'] }));
  assert.equal(thirdParty?.cause, false);
  assert.match(thirdParty?.text ?? '', /「360 安全卫士」/);
});

test('前端的状态集合与原生端 FirewallState 的序列化值一一对应', () => {
  const native = readFileSync('apps/desktop/src-tauri/src/firewall.rs', 'utf8');
  const block = native.slice(native.indexOf('pub(crate) fn as_str(self)'), native.indexOf('fn severity(self)'));
  const serialized = [...block.matchAll(/Self::\w+ => "(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual([...serialized].sort(), [...STATES].sort());
});

test('默认不碰防火墙：启动与设置页都不检查、不提权，只在点击 P2P 时进入闸口', () => {
  const lan = readFileSync('apps/desktop/src-tauri/src/lan.rs', 'utf8');
  assert.doesNotMatch(lan, /crate::firewall::/, 'LAN 服务启动不能碰防火墙');

  const runtime = readFileSync('apps/web/src/lan/runtime.ts', 'utf8');
  const start = runtime.slice(
    runtime.indexOf('export async function startLanRuntime'),
    runtime.indexOf('export async function stopLanRuntime'),
  );
  assert.doesNotMatch(start, /firewall/i, 'LAN 运行时启动不能检查防火墙');

  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');
  assert.doesNotMatch(settings, /LanFirewall|lan_firewall/);

  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const prepare = chat.slice(chat.indexOf('prepareP2p: async'));
  const gate = prepare.indexOf('withLanFirewallGate(');
  const probe = prepare.indexOf('probeLanPeer(');
  assert.ok(gate > 0 && gate < probe, '握手包在防火墙闸口里执行');
  assert.equal(
    [...chat.matchAll(/repairLanFirewall/g)].length,
    2,
    '提权修复只在 import 与 P2P 闸口里出现',
  );
});
