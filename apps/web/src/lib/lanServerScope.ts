/**
 * LAN 发现的服务器身份。
 *
 * issue #369：两台设备一边填 IP、一边填主机名登录同一台 Rocket.Chat 时，指纹
 * 由接入 URL 算出、互不相等，公告在原生端的过滤闸被静默丢掉，界面只剩一句
 * 「对方当前不可用 P2P 直传」。改由服务器自报的 `uniqueID` 决定身份后，入口
 * 地址不再参与判定。
 *
 * 这里只做取值与校验；哈希在原生端（`lan_identity::server_fingerprint_for`）。
 * 注意不要顺手把它接到 `serverUrl` 上：那个值同时是设备身份钥匙串的作用域，
 * 改了会让所有现存设备身份与信任固定失效。
 */

/** 与原生端 `MAX_SERVER_ID_LEN` 保持一致。 */
const MAX_SERVER_ID_LENGTH = 256;

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    // 必须与原生端 `char::is_control()` 一致：ASCII 控制字符，**以及** C1 段
    // （U+0080–U+009F）。只判 < 0x20 与 0x7f 会放过 C1，于是前端把值传下去、
    // 原生端 `build_runtime_identity` 报 "invalid Rocket.Chat server URL"，
    // 整个 LAN 服务起不来（issue #369 里最难查的一类：静默能力丢失）。
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * `settings.public` 里 `uniqueID` 的值可用时返回规范化后的字符串，否则返回 null
 * （原生端会退回接入 URL 归一化的老算法）。
 */
export function normalizeLanServerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SERVER_ID_LENGTH) return null;
  // 控制字符会被原生端的作用域校验直接拒掉，这里先滤掉，避免整次启动失败。
  if (hasControlCharacter(trimmed)) return null;
  return trimmed;
}

/** 「这次没读到」的退避档位：首次失败后依次等 2s、5s、15s、30s、60s，共约两分钟。 */
const SERVER_ID_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/**
 * 读 `uniqueID` 的结局。只有 `failed` 需要重试；`missing` 表示服务端确实没有这个设置，
 * 与 `lib/client` 的 `PublicSettingResult` 同形（这里不直接依赖它，保持本模块纯函数）。
 */
type ServerIdRead =
  | { status: 'found'; value: unknown }
  | { status: 'missing' }
  | { status: 'failed' };

export interface ResolvedLanServerId {
  serverId: string | null;
  /**
   * `server_id`：读到了可用的服务器身份；`missing`：服务端没有（老版本），退回 URL；
   * `unavailable`：重试用尽仍读不到，退回 URL——此时若对方读到了，两端会互相发现不了；
   * `cancelled`：等待期间会话已结束。
   */
  outcome: 'server_id' | 'missing' | 'unavailable' | 'cancelled';
}

/**
 * 解析 LAN 指纹要用的服务器身份。
 *
 * issue #369：一端读到 uniqueID、另一端因为一次限流退回 URL，两端指纹来源不同，就永远
 * 互相发现不了。所以「这次没读到」必须退避重试，只有「服务端确实没有」才立刻退回。
 */
export async function resolveLanServerId(
  read: () => Promise<ServerIdRead>,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
  } = {},
): Promise<ResolvedLanServerId> {
  const delays = options.delaysMs ?? SERVER_ID_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isCancelled = options.isCancelled ?? (() => false);
  for (let attempt = 0; ; attempt += 1) {
    const result = await read();
    if (result.status === 'found') {
      const serverId = normalizeLanServerId(result.value);
      return serverId ? { serverId, outcome: 'server_id' } : { serverId: null, outcome: 'missing' };
    }
    if (result.status === 'missing') return { serverId: null, outcome: 'missing' };
    if (attempt >= delays.length) return { serverId: null, outcome: 'unavailable' };
    await sleep(delays[attempt]);
    if (isCancelled()) return { serverId: null, outcome: 'cancelled' };
  }
}
