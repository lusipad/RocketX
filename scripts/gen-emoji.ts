/**
 * 从 emoji-toolkit（JoyPixels）生成 emoji 数据表。
 *
 * 为什么不直接在运行时依赖 emoji-toolkit：它的 emoji.json 有 1.5MB+，
 * 里面绝大部分字段（ascii、diversity、关键词分组）我们用不上。
 * 这里生成一份只含 shortcode → 字符 + 分类顺序的紧凑表，构建产物小一个数量级。
 *
 * Rocket.Chat 用的正是 JoyPixels/emojione 的 shortcode 体系，
 * 所以 :cowboy: 这类别名能和服务端、官方客户端对上。
 *
 *   pnpm gen:emoji
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const raw = require('emoji-toolkit/emoji.json') as Record<
  string,
  {
    shortname: string;
    shortname_alternates?: string[];
    category: string;
    order?: number | string;
    code_points: { fully_qualified: string };
  }
>;

/** 选择器里的分类与顺序（跳过 modifier / regional 这类不该单独出现的） */
const CATEGORIES: { key: string; label: string }[] = [
  { key: 'smileys_and_emotion', label: '表情' },
  { key: 'people', label: '人物' },
  { key: 'people_and_body', label: '人物' },
  { key: 'animals_and_nature', label: '动物与自然' },
  { key: 'nature', label: '动物与自然' },
  { key: 'food_and_drink', label: '食物与饮品' },
  { key: 'food', label: '食物与饮品' },
  { key: 'activities', label: '活动' },
  { key: 'travel_and_places', label: '旅行与地点' },
  { key: 'travel', label: '旅行与地点' },
  { key: 'objects', label: '物品' },
  { key: 'symbols', label: '符号' },
  { key: 'flags', label: '旗帜' },
];

const SKIP_CATEGORIES = new Set(['modifier', 'regional']);

function toChar(codePoints: string): string {
  return codePoints
    .split('-')
    .map((cp) => String.fromCodePoint(parseInt(cp, 16)))
    .join('');
}

/** shortcode（不带冒号）→ 字符，含全部别名 */
const map: Record<string, string> = {};
/** 选择器用：按分类归组，保持 emoji-toolkit 的官方顺序 */
const byCategory = new Map<string, { code: string; char: string; order: number }[]>();

for (const entry of Object.values(raw)) {
  if (SKIP_CATEGORIES.has(entry.category)) continue;
  const char = toChar(entry.code_points.fully_qualified);
  const primary = entry.shortname.replace(/:/g, '');
  if (!primary) continue;

  map[primary] = char;
  for (const alt of entry.shortname_alternates ?? []) {
    const code = alt.replace(/:/g, '');
    if (code && !map[code]) map[code] = char;
  }

  const label = CATEGORIES.find((c) => c.key === entry.category)?.label;
  if (!label) continue;
  const list = byCategory.get(label) ?? [];
  list.push({ code: primary, char, order: Number(entry.order ?? 0) });
  byCategory.set(label, list);
}

// 分类内按官方顺序排，分类之间按 CATEGORIES 的顺序
const seen = new Set<string>();
const groups: { label: string; codes: string[] }[] = [];
for (const { label } of CATEGORIES) {
  if (seen.has(label)) continue;
  seen.add(label);
  const list = byCategory.get(label);
  if (!list?.length) continue;
  list.sort((a, b) => a.order - b.order);
  groups.push({ label, codes: list.map((e) => e.code) });
}

const HEADER = `// 本文件由 scripts/gen-emoji.ts 生成，请勿手改。
// 数据源：emoji-toolkit（JoyPixels），与 Rocket.Chat 的 shortcode 体系一致。
// 运行 pnpm gen:emoji 重新生成。
`;

// map 和 groups 分开两个文件：
// map 渲染消息时要同步用到（:cowboy: → 🤠），必须进主包；
// groups 只有打开表情选择器才需要，单独成块懒加载，省下首屏体积。
writeFileSync(
  new URL('../apps/web/src/lib/emoji-map.ts', import.meta.url),
  `${HEADER}
/** shortcode（不含冒号）→ emoji 字符，包含官方别名（如 cowboy / face_with_cowboy_hat） */
export const EMOJI_MAP: Record<string, string> = ${JSON.stringify(map)};
`,
  'utf8',
);

writeFileSync(
  new URL('../apps/web/src/lib/emoji-groups.ts', import.meta.url),
  `${HEADER}
/** 选择器分组：分类标题 + 该类下的 shortcode（已按官方顺序排列） */
export const EMOJI_GROUPS: { label: string; codes: string[] }[] = ${JSON.stringify(groups)};
`,
  'utf8',
);

const total = Object.keys(map).length;
const chars = groups.reduce((n, g) => n + g.codes.length, 0);
console.log(
  `✓ 生成 emoji-map.ts / emoji-groups.ts：${total} 个 shortcode（含别名），选择器 ${chars} 个，${groups.length} 个分类`,
);
console.log(`  分类：${groups.map((g) => `${g.label}(${g.codes.length})`).join(' ')}`);
console.log(`  自检 :cowboy: → ${map.cowboy ?? '缺失!'}`);
