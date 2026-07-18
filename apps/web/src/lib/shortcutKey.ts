/**
 * 组合键里的主键名，统一小写。
 *
 * 焦点在输入框时中文输入法处于激活状态，微软拼音等会把 Ctrl+Shift+F 这类
 * 组合键先行拦截，浏览器收到的 e.key 是 'Process' 而不是真实字母，
 * 应用内快捷键就全部失效（issue #63）。此时退回物理键位 e.code 判断——
 * e.key 正常时仍以 e.key 优先，不影响非 QWERTY 布局。
 */
export function shortcutKeyOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (e.key !== 'Process') return e.key.toLowerCase();
  const physical = /^(?:Key|Digit)([a-zA-Z0-9])$/.exec(e.code);
  return physical ? physical[1].toLowerCase() : e.key.toLowerCase();
}
