import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const ROOT = 'apps/web/src';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * 扫描所有可执行字符串，而不是猜哪些字段最终会显示。
 *
 * 用户文案经常先写进 view model，再通过三元表达式、变量或 `as string`
 * 流入 JSX。只匹配 `key: '字面量'` 会漏掉这些路径。TypeScript AST 会排除
 * 注释，同时覆盖 JSX、模板字符串和普通字符串。
 */
function executableStrings(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const collect = (text: string): void => {
    if (/[一-龥]/.test(text)) out.push(text.trim());
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) collect(node.getText(sourceFile));
    else if (ts.isStringLiteralLike(node)) collect(node.text);
    else if (ts.isJsxText(node)) collect(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out.filter(Boolean);
}

/**
 * 界面上不许出现的内部说法。
 *
 * 这条纪律早就写在设计文档里，却只靠人记——2026-07-26 我自己刚写完
 * 「界面只说人话」，下一条提交就把「巡视」写进了 title。靠记性守不住，
 * 得让回归来守。
 *
 * 注：Rocket.Chat 自己的「话题/频道/讨论」是用户熟悉的产品词，不在此列。
 */
const FORBIDDEN = [
  '巡视',
  '台账',
  '对账',
  '传感器',
  // 「大脑」要写成功能名才算违规——「留在每个人的大脑里」是正常比喻，不能一刀切
  'AI 大脑',
  'API 大脑',
  'Codex 大脑',
  'ephemeral',
  'checkpoint',
  'payload',
  '接住',
  '接成任务',
  '盯住',
  '盯着',
  '盯它',
  '在盯',
];

test('AST 文案扫描覆盖三元表达式和模板字符串', () => {
  const texts = executableStrings(
    "const projection = { statusLabel: waiting ? `在盯 ${who}` : '已经完成' };",
    'projection.ts',
  );
  assert.ok(texts.some((text) => text.includes('在盯')));
  assert.ok(texts.includes('已经完成'));
});

test('界面文案不出现内部架构词——用户不该被要求先学一套黑话', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const text of executableStrings(source, file)) {
      // 唯一允许出现禁词的可执行字符串：系统提示明确告诉模型不要使用它们。
      if (file.endsWith('butler-rounds.ts') && text.startsWith('界面文案只说人话，不使用')) continue;
      for (const word of FORBIDDEN) {
        if (text.includes(word)) offenders.push(`${file}: 「${text}」含「${word}」`);
      }
    }
  }
  assert.deepEqual(offenders, [], `界面出现内部说法：\n${offenders.join('\n')}`);
});
