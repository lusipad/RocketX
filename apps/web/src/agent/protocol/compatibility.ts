export const CODEX_APP_SERVER_VERSION = '0.144.4' as const;

const VERSION_PATTERN = /Codex Desktop\/(\d+\.\d+\.\d+)/;

export function codexVersionFromUserAgent(userAgent: string): string | null {
  return VERSION_PATTERN.exec(userAgent)?.[1] ?? null;
}

export function assertCompatibleCodex(userAgent: string): void {
  const version = codexVersionFromUserAgent(userAgent);
  if (version !== CODEX_APP_SERVER_VERSION) {
    throw new Error(
      `Codex app-server 协议不兼容：需要 ${CODEX_APP_SERVER_VERSION}，实际 ${version ?? '未知'}。`,
    );
  }
}
