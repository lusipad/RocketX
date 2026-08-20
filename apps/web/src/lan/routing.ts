/**
 * 局域网文件直传的路由判定（纯函数，便于回归测试）。
 *
 * 设计结论（blueprint §5.1 / M9）：发文件时内核自动路由——可信同网段对端在线就
 * 走 P2P，否则回退 Rocket.Chat 上传，用户无感。小文件走 P2P 的握手开销不划算，
 * 因此加一道可配置的大小阈值；阈值为 0 表示任何大小都尝试直传。
 */

/** 默认阈值：50 MiB。 */
export const DEFAULT_LAN_FILE_MIN_BYTES = 50 * 1024 * 1024;

/** 把持久化/用户输入收敛为合法阈值：非负有限整数，非法值回退默认。 */
export function normalizeLanFileMinBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_LAN_FILE_MIN_BYTES;
  }
  return Math.floor(value);
}

/** 文件大小达到阈值才尝试 P2P 直传；阈值 0 表示任何大小都尝试。 */
export function shouldTryLanFileTransfer(sizeBytes: number, minBytes: number): boolean {
  return sizeBytes >= Math.max(0, minBytes);
}

/** 设置页可选的阈值档位（字节）。0 = 任何大小都尝试直传。 */
export const LAN_FILE_MIN_BYTES_OPTIONS = [
  { label: '任何文件', value: 0 },
  { label: '10 MB', value: 10 * 1024 * 1024 },
  { label: '50 MB（默认）', value: DEFAULT_LAN_FILE_MIN_BYTES },
  { label: '100 MB', value: 100 * 1024 * 1024 },
  { label: '1 GB', value: 1024 * 1024 * 1024 },
] as const;
