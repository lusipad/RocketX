/** 主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'rcx-theme';

export function loadTheme(): ThemeMode {
  // 这个函数在 ReactDOM.render 之前于启动路径上调用：localStorage 被浏览器策略
  // 或隐私模式禁用时访问它会抛 SecurityError，不兜住会整页白屏（渲染都到不了）。
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** 解析成实际生效的主题 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode);
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 存储不可用时仍然应用主题，只是重启后不记忆 */
  }
  applyTheme(mode);
}

/** 启动时应用，并在「跟随系统」下监听系统主题变化 */
export function initTheme(): void {
  applyTheme(loadTheme());
  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => {
      if (loadTheme() === 'system') applyTheme('system');
    });
}
