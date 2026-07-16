import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildDiagnosticReport,
  sanitizeDiagnosticText,
} from '../../apps/web/src/lib/diagnostics';

test('诊断文本会遮蔽常见凭据并移除换行注入', () => {
  const input =
    'Authorization: Bearer secret X-Auth-Token=abc password=hunter2 ' +
    'PAT: pat-value https://user:pass@example.com/path?token=query-secret\nforged';
  const safe = sanitizeDiagnosticText(input);

  for (const secret of ['secret', 'abc', 'hunter2', 'pat-value', 'user:pass', 'query-secret']) {
    assert.equal(safe.includes(secret), false);
  }
  assert.equal(safe.includes('\n'), false);
  assert.match(safe, /\[REDACTED\]/);
});

test('诊断报告保留多行日志但再次脱敏', () => {
  const report = buildDiagnosticReport(
    {
      appVersion: '1.2.3',
      authStatus: 'authed',
      chatConnection: 'connected',
      serverOrigin: 'https://chat.example.com',
      adoMode: 'direct',
    },
    '[info] started\n[error] token=do-not-export',
  );

  assert.match(report, /app_version: 1\.2\.3/);
  assert.match(report, /\[info\] started\n\[error\]/);
  assert.equal(report.includes('do-not-export'), false);
});

test('诊断导出复用已授权的二进制写入命令', () => {
  const source = readFileSync('apps/web/src/lib/diagnostics.ts', 'utf8');
  const exportSource = source.slice(source.indexOf('export async function exportDiagnostics'));

  assert.match(exportSource, /writeFile\(target,\s*new TextEncoder\(\)\.encode\(/);
  assert.doesNotMatch(exportSource, /writeTextFile/);
});
