import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildDiagnosticReport,
  sanitizeDiagnosticText,
} from '../../apps/web/src/lib/diagnostics';
import {
  clearMessageScrollDiagnostics,
  formatMessageScrollDiagnostics,
  getMessageScrollDiagnostics,
  recordMessageScrollDiagnostic,
} from '../../apps/web/src/lib/messageScrollDiagnostics';

test('诊断文本会遮蔽常见凭据并移除换行注入', () => {
  const input =
    'Authorization: Bearer secret X-Auth-Token=abc password=hunter2 ' +
    'PAT: pat-value https://user:pass@example.com/path?token=query-secret ' +
    'C:\\Users\\alice\\AppData\\Local\\Programs\\Codex\\codex.exe ' +
    'D:\\users\\bob\\AppData\\Roaming\\Codex\\auth.json ' +
    '/Users/alice/Library/Codex/bin/codex ' +
    '/home/alice/.config/codex/auth.json\nforged';
  const safe = sanitizeDiagnosticText(input);

  for (const secret of ['secret', 'abc', 'hunter2', 'pat-value', 'user:pass', 'query-secret', 'alice', 'bob']) {
    assert.equal(safe.includes(secret), false);
  }
  assert.equal(safe.includes('\n'), false);
  assert.match(safe, /\[REDACTED\]/);
  assert.match(safe, /Programs\\Codex\\codex\.exe/);
  assert.match(safe, /Codex\/bin\/codex/);
  assert.match(safe, /\.config\/codex\/auth\.json/);
});

test('诊断报告保留多行日志但再次脱敏', () => {
  clearMessageScrollDiagnostics();
  recordMessageScrollDiagnostic({
    rid: 'room-general',
    generation: 4,
    entry: 'latest',
    phase: 'frame',
    historyLoaded: true,
    messageCount: 80,
    scrollTop: 1180,
    scrollHeight: 1780,
    clientHeight: 600,
    bottomGap: 0,
    stickToBottom: true,
    userIntent: false,
    jumpVisible: false,
  });
  const report = buildDiagnosticReport(
    {
      appVersion: '1.2.3',
      authStatus: 'authed',
      chatConnection: 'connected',
      serverOrigin: 'https://chat.example.com',
      adoConfigured: true,
    },
    '[info] started\n[error] token=do-not-export',
  );

  assert.match(report, /app_version: 1\.2\.3/);
  assert.match(report, /ado_configured: true/);
  assert.match(report, /--- message scroll diagnostics ---/);
  assert.match(report, /room#[0-9a-f]{8}/);
  assert.equal(report.includes('room-general'), false);
  assert.match(report, /\[info\] started\n\[error\]/);
  assert.equal(report.includes('do-not-export'), false);
});

test('滚动诊断只存脱敏房间别名，并维持 200 条环形缓冲', () => {
  clearMessageScrollDiagnostics();
  for (let index = 0; index < 205; index += 1) {
    recordMessageScrollDiagnostic({
      rid: `room-${index}`,
      generation: index + 1,
      entry: index % 2 === 0 ? 'latest' : 'locate',
      phase: index % 2 === 0 ? 'scroll' : 'resize',
      historyLoaded: index % 3 === 0,
      messageCount: index,
      ...(index % 2 === 0
        ? {
            scrollTop: index * 10,
            scrollHeight: index * 10 + 300,
            clientHeight: 300,
            bottomGap: 0,
          }
        : {}),
      stickToBottom: index % 2 === 0,
      userIntent: index % 5 === 0,
      jumpVisible: index % 7 === 0,
    });
  }

  const records = getMessageScrollDiagnostics();
  assert.equal(records.length, 200);
  assert.equal(records[0]?.generation, 6);
  assert.equal(records.at(-1)?.generation, 205);
  assert.equal(records.some((record) => record.room.includes('room-')), false);
  assert.match(records[0]?.room ?? '', /^room#[0-9a-f]{8}$/);

  const formatted = formatMessageScrollDiagnostics(records.slice(0, 2));
  assert.match(formatted, /generation=6/);
  assert.match(formatted, /entry=locate|entry=latest/);
  assert.match(formatted, /scrollTop=\?|scrollTop=\d/);
});

test('诊断导出复用已授权的二进制写入命令', () => {
  const source = readFileSync('apps/web/src/lib/diagnostics.ts', 'utf8');
  const exportSource = source.slice(source.indexOf('export async function exportDiagnostics'));

  assert.match(exportSource, /writeFile\(target,\s*new TextEncoder\(\)\.encode\(/);
  assert.doesNotMatch(exportSource, /writeTextFile/);
});
