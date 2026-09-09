import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AUTH_IMAGE_EMPTY_RESPONSE,
  AUTH_IMAGE_RENDER_FAILED,
  classifyAuthImageFailure,
  describeAuthImageFailure,
} from '../../apps/web/src/lib/authImageDiagnostic';

/** RcApiError 的形状：Error + 数字 status（见 packages/rc-client/src/request.ts）。 */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { name: 'RcApiError', status });
}

const IMAGE_PATH = '/file-upload/aBcD1234/wooden-docks.svg';

test('图片失败原因不再塌缩：401 / 网络中断 / 空响应各自可区分（issue #382）', () => {
  const unauthorized = describeAuthImageFailure(IMAGE_PATH, httpError(401));
  const network = describeAuthImageFailure(IMAGE_PATH, new TypeError('Failed to fetch'));
  const empty = describeAuthImageFailure(IMAGE_PATH, new Error(AUTH_IMAGE_EMPTY_RESPONSE));

  assert.equal(unauthorized.kind, 'unauthorized');
  assert.equal(unauthorized.status, 401);
  assert.equal(network.kind, 'network');
  assert.equal(empty.kind, 'empty');

  // 核心断言：三种失败必须产生互不相同的诊断串。
  // 旧实现 .catch(() => null) 把它们全部压成同一句「图片加载失败」，
  // 于是线上只能反复要样本却拿不到任何可区分信号。
  const diagnostics = [unauthorized.diagnostic, network.diagnostic, empty.diagnostic];
  assert.equal(new Set(diagnostics).size, 3, `诊断串发生塌缩：${diagnostics.join(' | ')}`);
});

test('诊断串带上出错的文件路径，才能定位是哪一张图（issue #382）', () => {
  const failure = describeAuthImageFailure(IMAGE_PATH, httpError(404));
  assert.equal(failure.kind, 'not_found');
  assert.match(failure.diagnostic, /wooden-docks\.svg/);
  assert.match(failure.diagnostic, /kind=not_found/);
  assert.match(failure.diagnostic, /status=404/);
});

test('诊断串沿用脱敏：查询串里的 token 不落盘（issue #382）', () => {
  const failure = describeAuthImageFailure(
    '/file-upload/aBcD1234/secret.png?token=super-secret-value',
    httpError(403),
  );
  assert.doesNotMatch(failure.diagnostic, /super-secret-value/);
  assert.match(failure.diagnostic, /\[REDACTED\]/);
  assert.equal(failure.kind, 'unauthorized');
});

test('各类失败的分类覆盖：HTTP 状态、通道、解码、渲染（issue #382）', () => {
  assert.equal(classifyAuthImageFailure(httpError(403)), 'unauthorized');
  assert.equal(classifyAuthImageFailure(httpError(500)), 'server');
  assert.equal(classifyAuthImageFailure(httpError(418)), 'http_status');
  // Tauri 原生通道读不出响应时抛的是不带 status 的网络类错误。
  assert.equal(classifyAuthImageFailure(new Error('error sending request')), 'network');
  assert.equal(classifyAuthImageFailure(new Error(AUTH_IMAGE_EMPTY_RESPONSE)), 'empty');
  assert.equal(classifyAuthImageFailure(new Error(AUTH_IMAGE_RENDER_FAILED)), 'render');
  // 字节读取/嗅探阶段的异常要与网络失败区分开。
  assert.equal(classifyAuthImageFailure(new Error('The blob could not be read')), 'decode');
  assert.equal(classifyAuthImageFailure('something else entirely'), 'unknown');
});

test('AuthImage 不再吞掉失败原因（issue #382）', () => {
  const source = readFileSync('apps/web/src/components/AuthImage.tsx', 'utf8');

  // 这一行就是 #382 停在「请提供失败样本」八轮的机制性原因。
  assert.doesNotMatch(source, /\.catch\(\(\) => null\)/);
  // 失败路径必须走诊断通道，否则桌面端导出的日志里依旧什么都没有。
  assert.match(source, /writeAuthImageDiagnostic/);
  // 零字节响应会通过 <img> 静默失败，必须在拿到 blob 时就判定。
  assert.match(source, /AUTH_IMAGE_EMPTY_RESPONSE/);
  // 字节拿到了但 WebView 解不出来，同样要留下证据。
  assert.match(source, /AUTH_IMAGE_RENDER_FAILED/);
});
