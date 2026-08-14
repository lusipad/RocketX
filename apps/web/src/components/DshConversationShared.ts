export function workspaceLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function ageLabel(timestamp: number): string {
  const base = timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000;
  const elapsed = Math.max(0, Date.now() - base);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  return `${Math.floor(elapsed / 86_400_000)} 天`;
}
