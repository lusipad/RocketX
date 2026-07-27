export const CODEX_APP_SERVER_VERSION = '0.144.4' as const;
export const CODEX_PROTOCOL_BASELINE = CODEX_APP_SERVER_VERSION;
export const CODEX_MINIMUM_CANDIDATE = '0.140.0' as const;
export const CODEX_VERIFIED_VERSIONS = [CODEX_PROTOCOL_BASELINE] as const;

const VERSION_PATTERN = /(?:Codex Desktop|rocketx)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

export function codexVersionFromUserAgent(userAgent: string): string | null {
  return VERSION_PATTERN.exec(userAgent)?.[1] ?? null;
}

export function assertCodexHandshake(userAgent: unknown, processVersion: string): string {
  if (typeof userAgent !== 'string') {
    throw new Error('Codex app-server 缺少 RocketX 所需的 initialize.userAgent 能力。');
  }
  const version = codexVersionFromUserAgent(userAgent);
  if (!version) {
    throw new Error(`Codex app-server 返回了无法识别的 userAgent：${userAgent}`);
  }
  if (version !== processVersion) {
    throw new Error(`Codex app-server 握手版本不一致：进程报告 ${processVersion}，初始化报告 ${version}。`);
  }
  return version;
}
