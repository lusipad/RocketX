/**
 * 聊天消息里的 UNC 共享路径（\\nas\share\dir\file.pdf）识别（纯函数，便于回归测试）。
 *
 * 保守策略：段内不允许空白字符——路径带空格时只匹配到空格前。
 * 宁可少匹配，也不能把后面的中文正文吞进路径。
 */

/** 主机名/段内不允许的字符：空白、反斜杠与 Windows 非法文件名字符。 */
const SEGMENT = '[^\\s\\\\/:*?"<>|]';
const UNC_PATH_RE = new RegExp(
  `\\\\\\\\${SEGMENT}{1,253}\\\\${SEGMENT}{1,255}(?:\\\\${SEGMENT}{0,255})*`,
  'g',
);

/** 路径后面常紧跟的中文/英文标点，不属于路径本身。 */
const TRAILING_PUNCT_RE = /[。，、；！？,.;:!?)\]}>'"”’』」]+$/u;

/** 从消息文本提取 UNC 路径，去尾标点并去重。 */
export function extractUncPaths(text: string): string[] {
  if (!text.includes('\\\\')) return [];
  const seen = new Set<string>();
  for (const raw of text.match(UNC_PATH_RE) ?? []) {
    const cleaned = raw.replace(TRAILING_PUNCT_RE, '');
    // 至少 \\host\share 三段结构才有效
    if (cleaned.split('\\').filter(Boolean).length >= 2) seen.add(cleaned);
  }
  return [...seen];
}

/** 取 UNC 路径的主机名（用于确认弹窗提示要连接的目标）。 */
export function uncHostOf(path: string): string {
  return path.split('\\').filter(Boolean)[0] ?? '';
}
