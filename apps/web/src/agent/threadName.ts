/** Codex 线程名长度上限：过长在 codex resume / Codex App 列表里会被截没 */
const MAX_NAME_LENGTH = 60;

/**
 * RocketX 创建的原生 Codex 线程统一命名为「RocketX <场景> · <明细>」。
 * 这些线程本就落盘在 CODEX_HOME 的会话库里，可在 codex resume 和
 * Codex App 中继续；起名后在列表里能认出来自哪个房间/工作项，而不是一串 ID。
 */
export function rocketxThreadName(scope: string, detail?: string | null): string {
  const base = `RocketX ${scope}`.trim();
  const extra = detail?.replace(/\s+/gu, ' ').trim();
  const name = extra ? `${base} · ${extra}` : base;
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;
}

/** 目录路径的最后一段，用作执行间线程名的明细 */
export function workspaceLabel(path: string | undefined): string | undefined {
  return path?.split(/[\\/]/u).filter(Boolean).at(-1);
}
