import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = 'apps/web/src';

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * 被形状卡住尺寸的东西：圆角标里的数字、窄徽章、键帽。
 * 这些地方 12px 是空间约束的结果，不是排版选择。
 */
const SHAPE_CONSTRAINED = /rounded-full|<kbd|min-w-4|h-4 /;

/**
 * text-2xs（12px）只能给角标、徽章、键帽。
 *
 * 收敛之前有 132 处在用它，其中 123 处是成句的文字——标签、状态提示、
 * 空状态说明。而 12px 和 13px 只差 1px，肉眼分不出，于是它事实上成了
 * 「次要文字」的第二个档位，选哪个全凭手感；代价是 1080p 上那些中文
 * 笔画糊成一团（issue #135 报的「看上去很模糊」可能就有这一份）。
 *
 * 靠记性守不住，所以让回归来守。要加新的次要文字，用 text-xs 配 text-ink-3
 * ——层次交给颜色，不要再往下压字号。
 */
test('12px 只给角标和键帽，成句的文字不许用', () => {
  const offenders: string[] = [];
  for (const file of tsxFiles(ROOT)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('text-2xs')) continue;
    source.split('\n').forEach((line, index) => {
      if (!line.includes('text-2xs') || SHAPE_CONSTRAINED.test(line)) return;
      offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方把 12px 当成了次要文字档，改用 text-xs：\n${offenders.join('\n')}`,
  );
});

/**
 * text-xl 有意不在这份表里：全仓库只有几处用它，走 Tailwind 默认值就够，
 * 没必要为此再养一个 token。改这条断言之前先想清楚新档位的用途，
 * 别让「差 1px 的两个档」那种情况再出现一次。
 */
test('自定义字号档位没有悄悄增殖', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');
  const scale = [...css.matchAll(/--text-([\w-]+):\s*([\d.]+)rem/g)]
    .filter(([, name]) => !name.includes('line-height'))
    .map(([, name, rem]) => ({ name, px: Number(rem) * 16 }));

  assert.deepEqual(scale.map((item) => item.name), ['2xs', 'xs', 'sm', 'base', 'lg']);

  // 相邻两档至少差 1px，否则选哪个纯凭手感——2xs 当次要文字用就是这么来的
  for (let index = 1; index < scale.length; index++) {
    const gap = scale[index].px - scale[index - 1].px;
    assert.ok(
      gap >= 1,
      `${scale[index - 1].name}(${scale[index - 1].px}px) 和 ${scale[index].name}(${scale[index].px}px) 只差 ${gap}px，分不出来`,
    );
  }
});
