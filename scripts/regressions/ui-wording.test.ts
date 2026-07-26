import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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
 * 只看用户能读到的字符串：JSX 文本、title/aria-label/placeholder、toast。
 * 注释与 console 里出现架构词是正常的——那是写给维护者的。
 */
function userFacingText(source: string, isJsx: boolean): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  // JSX 里的裸中文文本。只对 .tsx 跑——.ts 里没有 JSX，硬套会把
  // `throw new Error('...')` 之类的代码当成界面文本报上来。
  if (isJsx) {
    for (const match of withoutComments.matchAll(/>([^<>{}]*[一-龥][^<>{}]*)</g)) {
      out.push(match[1].trim());
    }
  }
  // title / aria-label / placeholder / toast 里的中文串
  for (const match of withoutComments.matchAll(
    /(?:title|aria-label|placeholder|label)=\{?['"`]([^'"`]*[一-龥][^'"`]*)['"`]/g,
  )) {
    out.push(match[1]);
  }
  for (const match of withoutComments.matchAll(
    /toast\.(?:success|error|info|undo|loading)\(\s*['"`]([^'"`]*[一-龥][^'"`]*)['"`]/g,
  )) {
    out.push(match[1]);
  }
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
];

test('界面文案不出现内部架构词——用户不该被要求先学一套黑话', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const text of userFacingText(source, file.endsWith('.tsx'))) {
      for (const word of FORBIDDEN) {
        if (text.includes(word)) offenders.push(`${file}: 「${text}」含「${word}」`);
      }
    }
  }
  assert.deepEqual(offenders, [], `界面出现内部说法：\n${offenders.join('\n')}`);
});
