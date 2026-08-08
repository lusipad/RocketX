import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ButlerMarketplaceTimeoutError,
  isRemoteButlerMarketplaceSource,
  withButlerMarketplaceDeadline,
} from '../../apps/web/src/lib/butlerMarketplace';

test('Marketplace 离线判断只拦网络来源，不拦本地路径', () => {
  for (const source of [
    'https://github.com/example/skills',
    'http://localhost:3000/catalog',
    'git://github.com/example/skills',
    'ssh://git@example.com/skills',
    'git@example.com:skills.git',
    '\\\\fileserver\\skills',
  ]) {
    assert.equal(isRemoteButlerMarketplaceSource(source), true, source);
  }

  for (const source of [
    'C:\\skills\\marketplace',
    'D:/skills/marketplace',
    './skills/marketplace',
    'file:///C:/skills/marketplace',
  ]) {
    assert.equal(isRemoteButlerMarketplaceSource(source), false, source);
  }
});

test('Marketplace 操作在截止时间内完成时原样返回', async () => {
  assert.equal(
    await withButlerMarketplaceDeadline(Promise.resolve('ok'), '读取市场', 100),
    'ok',
  );
});

test('Marketplace 操作超过截止时间后明确退出等待', async () => {
  await assert.rejects(
    withButlerMarketplaceDeadline(
      new Promise<never>(() => undefined),
      '读取市场',
      5,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ButlerMarketplaceTimeoutError);
      assert.match(error.message, /已停止等待/);
      assert.match(error.message, /请先刷新状态再重试/);
      return true;
    },
  );
});
