/** 主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'rcx-theme';

export function loadTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
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
  localStorage.setItem(THEME_KEY, mode);
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
