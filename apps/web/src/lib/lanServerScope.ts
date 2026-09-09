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
    return code < 0x20 || code === 0x7f;
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
