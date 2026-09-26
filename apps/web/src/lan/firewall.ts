/**
 * 本机 Windows 防火墙对 RocketX 局域网入站的判定（原生端 `firewall.rs`）。
 *
 * issue #369：两端只要有一端的入站被挡，发现与直传都会失败；而 Windows 在「允许访问」
 * 弹窗被取消、或由非管理员点击时会生成**阻止**规则，此后一直生效。
 *
 * 默认不检查也不要管理员权限：只有用户点击 P2P 直传时才检查；确定被挡才请求一次 UAC；
 * 拿不准的情况（部分放行、读不到、有判定不了的阻止规则）先照常直传，失败了再请求。
 */
export type LanFirewallState =
  | 'ok'
  | 'partial'
  | 'missing_rule'
  | 'blocked'
  | 'blocked_other'
  | 'block_all_inbound'
  | 'managed'
  | 'third_party'
  | 'unsupported'
  | 'unknown';

export interface LanFirewallStatus {
  state: LanFirewallState;
  /** 判定依据：对方所在网卡 / 带网关的物理网卡 / 兜底的所有活动配置文件。 */
  scope: 'peer' | 'lan' | 'all_profiles';
  profiles: Array<'domain' | 'private' | 'public'>;
  /** 已接管防火墙的第三方安全软件名（Windows 安全中心）。 */
  thirdParty: string[];
  uncertainRules: number;
  /** 范围判定不了的阻止规则条数：可能是「判为放行却连不上」的原因。 */
  uncertainBlocks: number;
}

export const UNKNOWN_LAN_FIREWALL: LanFirewallStatus = {
  state: 'unknown',
  scope: 'all_profiles',
  profiles: [],
  thirdParty: [],
  uncertainRules: 0,
  uncertainBlocks: 0,
};

export interface LanFirewallAdvice {
  /** 失败提示里用的一句话；空串表示防火墙这一侧没有可说的。 */
  text: string;
  /** 点击 P2P 时就请求管理员授权（确定会挡住直传、且本机一键放行能修好）。 */
  elevate: boolean;
  /** 直传失败后再请求一次授权（拿不准防火墙是不是原因，但放行可能有用）。 */
  elevateOnFailure: boolean;
  /** 确定会导致直传失败。 */
  breaksP2p: boolean;
}

function quoteNames(names: string[]): string {
  return names.map((name) => `「${name}」`).join('、');
}

export function lanFirewallAdvice(status: LanFirewallStatus): LanFirewallAdvice {
  const none = { text: '', elevate: false, elevateOnFailure: false, breaksP2p: false };
  switch (status.state) {
    case 'missing_rule':
      return {
        text: '本机防火墙没有放行 RocketX 的局域网连接，对方发现不了本机、也连不进来。',
        elevate: true,
        elevateOnFailure: false,
        breaksP2p: true,
      };
    case 'blocked':
      return {
        text: '本机防火墙存在阻止 RocketX 的规则（通常是「允许访问」弹窗被取消后生成的），直传必然失败。',
        elevate: true,
        elevateOnFailure: false,
        breaksP2p: true,
      };
    case 'blocked_other':
      return {
        text: '本机有其他防火墙规则拦截了 RocketX 使用的局域网端口，一键放行覆盖不了；请管理员检查防火墙入站规则。',
        elevate: false,
        elevateOnFailure: false,
        breaksP2p: true,
      };
    case 'block_all_inbound':
      return {
        text: '当前网络开启了「阻止所有传入连接」，任何放行都无效；请在 Windows 安全中心 → 防火墙和网络保护中关闭该选项后重试。',
        elevate: false,
        elevateOnFailure: false,
        breaksP2p: true,
      };
    case 'managed':
      return {
        text: '本机防火墙由组织策略管理，无法在本机放行；请联系 IT 为 RocketX 放行局域网入站。',
        elevate: false,
        elevateOnFailure: false,
        breaksP2p: true,
      };
    case 'third_party':
      return {
        ...none,
        text: `本机防火墙由${quoteNames(status.thirdParty)}接管，RocketX 无法检查；如直传失败，请在其中放行 RocketX 的局域网连接。`,
      };
    case 'partial':
    case 'unknown':
      return { ...none, elevateOnFailure: true };
    case 'ok':
      return { ...none, elevateOnFailure: status.uncertainBlocks > 0 };
    case 'unsupported':
      return none;
  }
}

/**
 * 失败提示里关于本机防火墙的说明。`cause` 为真表示防火墙确定是失败原因（提示应以它开头），
 * 否则只是附在原始错误后面的补充。与防火墙无关时返回 null。
 * 第三方安全软件即使没有关掉 Windows 防火墙，也可能自己拦截，所以只要登记了就提一句。
 */
export function lanFirewallFailureHint(
  status: LanFirewallStatus,
): { text: string; cause: boolean } | null {
  const advice = lanFirewallAdvice(status);
  if (advice.breaksP2p) {
    return {
      text: advice.elevate
        ? `${advice.text}再次点击 P2P 直传，并在系统窗口中允许管理员授权即可放行。`
        : advice.text,
      cause: true,
    };
  }
  if (status.state === 'third_party') return { text: advice.text, cause: false };
  if (status.thirdParty.length > 0) {
    return {
      text: `如仍失败，请检查${quoteNames(status.thirdParty)}是否拦截了 RocketX 的局域网连接。`,
      cause: false,
    };
  }
  return null;
}

export type LanFirewallElevationReason =
  /** 点击时就确定被挡。 */
  | 'blocked'
  /** 直传失败了，防火墙可能是原因。 */
  | 'after_failure';

/**
 * 点击 P2P 直传的防火墙闸口：只读检查 → 确定被挡时请求一次授权 → 执行直传；
 * 拿不准的情况先直传，失败了才请求授权并重试一次。放行后要等对方公告重新到达
 * （每 3 秒一次）再握手。用户拒绝授权或授权无效时抛出原来的错误。
 */
export async function withLanFirewallGate<T>(deps: {
  check: () => Promise<LanFirewallStatus>;
  repair: () => Promise<LanFirewallStatus | null>;
  waitForPeer: () => Promise<unknown>;
  attempt: () => Promise<T>;
  onElevate?: (reason: LanFirewallElevationReason) => void;
}): Promise<T> {
  const repaired = async (reason: LanFirewallElevationReason): Promise<boolean> => {
    deps.onElevate?.(reason);
    const status = await deps.repair().catch(() => null);
    return status !== null && !lanFirewallAdvice(status).breaksP2p;
  };
  const status = await deps.check().catch(() => UNKNOWN_LAN_FIREWALL);
  const advice = lanFirewallAdvice(status);
  if (advice.elevate && (await repaired('blocked'))) await deps.waitForPeer();
  try {
    return await deps.attempt();
  } catch (error) {
    if (advice.elevate || !advice.elevateOnFailure) throw error;
    if (!(await repaired('after_failure'))) throw error;
    await deps.waitForPeer();
    return deps.attempt();
  }
}
