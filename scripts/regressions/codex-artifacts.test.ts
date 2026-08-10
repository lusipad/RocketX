import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import {
  codexArtifactFromLink,
  codexArtifactsFromMarkdown,
  sandboxArtifactHtml,
} from '../../apps/web/src/lib/codexArtifacts';
import { renderMarkdown } from '../../apps/web/src/lib/markdown';

(globalThis as Record<string, unknown>).React = React;

test('Codex 本地文件链接会进入 Artifact 渲染边界', () => {
  const links: Array<{ label: string; href: string }> = [];

  renderMarkdown(
    'HTML 已生成：[D:\\tmp\\ado_wbs.html](/D:/tmp/ado_wbs.html)。',
    undefined,
    (label, href) => {
      links.push({ label, href });
      return label;
    },
  );

  assert.deepEqual(links, [{
    label: 'D:\\tmp\\ado_wbs.html',
    href: '/D:/tmp/ado_wbs.html',
  }]);
});

test('Artifact 链接归一化 Windows 与工作区相对路径', () => {
  assert.deepEqual(
    codexArtifactFromLink('D:\\tmp\\ado_wbs.html', '/D:/tmp/ado_wbs.html', 'D:\\tmp'),
    {
      path: 'D:\\tmp\\ado_wbs.html',
      name: 'ado_wbs.html',
      kind: 'html',
      mimeType: 'text/html',
    },
  );

  assert.deepEqual(
    codexArtifactFromLink('计划', './plan.md', 'D:\\tmp'),
    {
      path: 'D:\\tmp\\plan.md',
      name: 'plan.md',
      kind: 'markdown',
      mimeType: 'text/markdown',
    },
  );
});

test('普通网页链接和危险协议不冒充本地 Artifact', () => {
  assert.equal(codexArtifactFromLink('官网', 'https://example.com', 'D:\\tmp'), null);
  assert.equal(codexArtifactFromLink('危险', 'javascript:alert(1)', 'D:\\tmp'), null);
});

test('一条回复可提取多个 Artifact，并为 HTML 预览注入隔离 CSP', () => {
  assert.deepEqual(
    codexArtifactsFromMarkdown(
      '查看 [页面](./out.html) 和 [数据](./data.json)，网页在 [这里](https://example.com)。',
      'D:\\tmp',
    ).map((artifact) => artifact.name),
    ['out.html', 'data.json'],
  );

  const html = sandboxArtifactHtml('<html><head><title>WBS</title></head><body>ok</body></html>');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<title>WBS<\/title>/);
});

test('Artifact 由桌面宿主在当前工作区边界内读取，不依赖 Codex Runtime', () => {
  const store = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const panel = readFileSync('apps/web/src/components/CodexArtifactPanel.tsx', 'utf8');
  const desktop = readFileSync('apps/desktop/src-tauri/src/proc.rs', 'utf8');
  const main = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');

  assert.match(store, /invoke<string>\('codex_artifact_read', \{ workspaceRoot, path \}\)/);
  assert.match(store, /invoke<void>\('codex_artifact_open', \{ workspaceRoot, path \}\)/);
  assert.match(store, /invoke<void>\('codex_artifact_reveal', \{ workspaceRoot, path \}\)/);
  assert.doesNotMatch(panel, /@tauri-apps\/plugin-opener/);
  assert.match(desktop, /fn resolve_codex_artifact\(root: &Path, target: &Path\)/);
  assert.match(desktop, /contained_existing_path\(root, target\)\?/);
  assert.match(desktop, /MAX_ARTIFACT_BYTES/);
  assert.match(main, /proc::codex_artifact_read/);
  assert.match(main, /proc::codex_artifact_open/);
  assert.match(main, /proc::codex_artifact_reveal/);
});
