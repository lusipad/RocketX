export const BUTLER_MARKETPLACE_CATALOG_TIMEOUT_MS = 8_000;
export const BUTLER_MARKETPLACE_LOCAL_TIMEOUT_MS = 4_000;
export const BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS = 15_000;

export class ButlerMarketplaceTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(
      `${operation}超过 ${Math.ceil(timeoutMs / 1_000)} 秒，已停止等待。`
      + 'Codex 可能仍在后台处理，请先刷新状态再重试。',
    );
    this.name = 'ButlerMarketplaceTimeoutError';
  }
}

export async function withButlerMarketplaceDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ButlerMarketplaceTimeoutError(label, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isRemoteButlerMarketplaceSource(source: string): boolean {
  const value = source.trim();
  return /^(?:https?|git|ssh):\/\//iu.test(value)
    || /^git@[^:]+:/iu.test(value)
    || /^\\\\/u.test(value);
}
