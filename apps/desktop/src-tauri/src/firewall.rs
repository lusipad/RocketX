//! Windows 防火墙入站检查与按需修复（issue #369：两台 Windows 互相发现不到）。
//!
//! LAN 发现依赖 UDP 45826 入站，直传依赖随机 TCP 端口入站。两端都必须放行：
//! A 收不到 B 的公告就发现不了 B，B 挡住入站 TCP 则 A 的握手连不上——只要一台
//! 被挡，两个方向都失败。而回环流量不过防火墙，所以单机测试永远看不到这一层。
//!
//! 原先的做法（启动时静默 `netsh add rule`）从未生效过：安装器是 currentUser，
//! 程序以中完整性运行，netsh 必报「请求的操作需要提升」，且错误写在 stdout、
//! 日志只记了空的 stderr。更糟的是 Windows 首次监听时会弹「允许访问」：
//! 非管理员无论点什么、管理员点了取消，都会生成**阻止**规则，而显式阻止规则
//! 优先于任何允许规则——此后怎么修代码都没用。
//!
//! 现在默认不碰防火墙、不要管理员权限。只有用户点击 P2P 直传时才检查，确定被挡
//! 才通过一次 UAC 修复。检查尽量贴近 Windows 防火墙的真实判定：
//! - 只看局域网**实际走的网卡**所属的网络配置文件（有对方地址时按对方所在网段/路由
//!   定位网卡；否则取带网关的物理网卡），而不是所有活动配置文件的并集——否则 VPN/TUN
//!   虚拟网卡的「公用」会造成误报，有线「公用」+ Wi-Fi「专用」会造成漏报；
//! - 读取每个配置文件的「阻止所有传入连接」与默认入站动作；
//! - 规则按真实范围判定：程序/服务、协议、本地端口、本地/远程地址、网卡类型；
//!   不带程序路径的通用规则同样计入；判定不了的范围（如指定网卡、特殊地址关键字）
//!   既不当放行也不当阻止，只计数写进诊断；
//! - Windows 防火墙被第三方安全软件接管时，通过安全中心读出产品名。

use std::net::Ipv4Addr;

use serde::Serialize;

/// 专用/域网络的放行规则名。
pub(crate) const PRIVATE_RULE_NAME: &str = "RocketX LAN P2P";
/// 公用网络（仅本地子网）的放行规则名。
pub(crate) const PUBLIC_RULE_NAME: &str = "RocketX LAN P2P (public, local subnet)";

pub(crate) const PROFILE_DOMAIN: i32 = 1;
pub(crate) const PROFILE_PRIVATE: i32 = 2;
pub(crate) const PROFILE_PUBLIC: i32 = 4;
const PROTOCOL_TCP: i32 = 6;
const PROTOCOL_UDP: i32 = 17;
const PROTOCOL_ANY: i32 = 256;
const DISCOVERY_PORT: u16 = crate::native::lan_discovery::UDP_PORT;

/// 本机防火墙对 RocketX 局域网入站的判定。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FirewallState {
    /// 防火墙关闭，或局域网网卡上发现与直传都已放行。
    Ok,
    /// 定位不到局域网网卡时的兜底判定：部分网络类型放行、部分没有。
    Partial,
    /// 没有覆盖直传的放行规则，入站被默认策略拦截。
    MissingRule,
    /// 存在针对本程序的阻止规则（通常由「允许访问」弹窗被取消或非管理员点击生成）。
    Blocked,
    /// 不针对本程序的阻止规则（端口/全局规则）拦截了直传；删本程序规则修不了。
    BlockedOther,
    /// 当前网络开启了「阻止所有传入连接」，任何放行规则都无效。
    BlockAllInbound,
    /// 组策略接管或阻止所有入站，本机规则无效，需要 IT 管理员处理。
    Managed,
    /// Windows 防火墙已关闭且由第三方安全软件接管，本机无法检查。
    ThirdParty,
    /// 非 Windows 平台，不适用。
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// 读取防火墙状态失败。
    Unknown,
}

impl FirewallState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::MissingRule => "missing_rule",
            Self::Blocked => "blocked",
            Self::BlockedOther => "blocked_other",
            Self::BlockAllInbound => "block_all_inbound",
            Self::Managed => "managed",
            Self::ThirdParty => "third_party",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
        }
    }

    /// 多块网卡/两种协议的判定合并时取最需要用户处理的一个；修不了的排在前面。
    fn severity(self) -> u8 {
        match self {
            Self::Ok | Self::Unsupported => 0,
            Self::Partial => 1,
            Self::ThirdParty => 2,
            Self::Unknown => 3,
            Self::MissingRule => 4,
            Self::Blocked => 5,
            Self::BlockedOther => 6,
            Self::BlockAllInbound => 7,
            Self::Managed => 8,
        }
    }
}

/// 判定依据的是哪些网卡。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FirewallScope {
    /// 按对方已发现的地址定位到的网卡。
    Peer,
    /// 没有对方地址，按带网关的物理网卡判断。
    Lan,
    /// 定位不到网卡，退回所有活动网络配置文件。
    AllProfiles,
}

impl FirewallScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Peer => "peer",
            Self::Lan => "lan",
            Self::AllProfiles => "all_profiles",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub state: FirewallState,
    pub scope: FirewallScope,
    /// 参与判定的网络配置文件：`domain` / `private` / `public`。
    pub profiles: Vec<&'static str>,
    /// 已启用的第三方防火墙产品名（来自 Windows 安全中心）。
    pub third_party: Vec<String>,
    /// 范围无法判定、因此没有计入的规则条数（指定网卡、特殊地址关键字等）。
    pub uncertain_rules: u32,
    /// 其中的阻止规则条数：只有它们可能是「判为放行却连不上」的原因。
    pub uncertain_blocks: u32,
}

impl FirewallStatus {
    fn bare(state: FirewallState) -> Self {
        Self {
            state,
            scope: FirewallScope::AllProfiles,
            profiles: Vec::new(),
            third_party: Vec::new(),
            uncertain_rules: 0,
            uncertain_blocks: 0,
        }
    }
}

/// 网卡类型，对应规则的 `InterfaceTypes`（Lan / Wireless / RemoteAccess）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IfKind {
    Ethernet,
    Wireless,
    RemoteAccess,
    Other,
}

impl IfKind {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn from_if_type(if_type: u32) -> Self {
        match if_type {
            6 => Self::Ethernet,
            71 => Self::Wireless,
            23 | 131 => Self::RemoteAccess,
            _ => Self::Other,
        }
    }
}

/// 一块处于连接状态、带 IPv4 地址的网卡。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LanInterface {
    pub index: u32,
    pub kind: IfKind,
    pub address: Ipv4Addr,
    pub prefix: u8,
    pub has_gateway: bool,
    /// 该网卡所属网络的防火墙配置文件位（单个）。
    pub profile: i32,
}

impl LanInterface {
    fn contains(&self, ip: Ipv4Addr) -> bool {
        if self.prefix == 0 || self.prefix > 32 || self.address.is_unspecified() {
            return false;
        }
        let mask = u32::MAX << (32 - u32::from(self.prefix));
        u32::from(self.address) & mask == u32::from(ip) & mask
    }
}

/// 一条已启用的入站规则里与判定有关的字段。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RuleView {
    pub allow: bool,
    pub program: String,
    pub service: String,
    pub protocol: i32,
    pub profiles: i32,
    pub local_ports: String,
    pub local_addresses: String,
    pub remote_addresses: String,
    pub interface_types: String,
    /// 规则限定了具体网卡（`Interfaces` 非空）；无法与网卡名可靠对应，按不确定处理。
    pub specific_interfaces: bool,
    /// UWP / AppContainer 应用的规则（有应用包或所属用户）。注意 COM 不暴露 `PFN=`，
    /// 这类规则的 `ApplicationName` 为空，不看所属用户就会被误当成「对所有程序生效」。
    pub app_scoped: bool,
    /// 规则只对列出的本地用户生效（`LocalUserAuthorizedList`）。
    pub local_users: bool,
    /// 规则要求 IPsec 认证/加密（`SecureFlags` 或远程用户/计算机授权列表）；
    /// RocketX 的直传不走 IPsec，这类放行规则不覆盖它。
    pub requires_ipsec: bool,
}

/// 单个网络配置文件的全局开关。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProfilePolicy {
    pub profile: i32,
    pub enabled: bool,
    /// 「阻止所有传入连接，包括位于允许应用列表中的应用」。
    pub block_all: bool,
    /// 默认入站动作是否为允许（Windows 默认是阻止）。
    pub default_allow: bool,
}

/// 组策略对本机规则的影响（对应 `NET_FW_MODIFY_STATE`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyState {
    Local,
    GroupPolicyOverride,
    InboundBlocked,
}

/// 采集到的本机防火墙现场。
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub exe: String,
    pub policies: Vec<ProfilePolicy>,
    pub modify: PolicyState,
    pub rules: Vec<RuleView>,
    pub interfaces: Vec<LanInterface>,
    /// `CurrentProfileTypes`：定位不到网卡时的兜底。
    pub active_profiles: i32,
    pub third_party: Vec<String>,
}

/// 这次要判定的连接：对方地址（可能未知）、对方地址的路由出口网卡、本机 TCP 端口。
#[derive(Clone, Debug, Default)]
pub(crate) struct Target {
    pub peers: Vec<Ipv4Addr>,
    pub best_interfaces: Vec<u32>,
    pub tcp_port: Option<u16>,
}

/// 规则范围是否覆盖这次连接。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Match {
    Yes,
    No,
    Unknown,
}

impl Match {
    fn and(self, other: Match) -> Match {
        match (self, other) {
            (Match::No, _) | (_, Match::No) => Match::No,
            (Match::Unknown, _) | (_, Match::Unknown) => Match::Unknown,
            _ => Match::Yes,
        }
    }

    /// 多个候选里任意一个覆盖即可（地址/端口列表的逗号分隔项）。
    fn any(items: impl IntoIterator<Item = Match>) -> Match {
        let mut result = Match::No;
        for item in items {
            match item {
                Match::Yes => return Match::Yes,
                Match::Unknown => result = Match::Unknown,
                Match::No => {}
            }
        }
        result
    }
}

fn profile_names(mask: i32) -> Vec<&'static str> {
    [
        (PROFILE_DOMAIN, "domain"),
        (PROFILE_PRIVATE, "private"),
        (PROFILE_PUBLIC, "public"),
    ]
    .into_iter()
    .filter(|(bit, _)| mask & bit != 0)
    .map(|(_, name)| name)
    .collect()
}

fn is_any(spec: &str) -> bool {
    let spec = spec.trim();
    spec.is_empty() || spec == "*"
}

/// 规则里的程序路径可能是小写、正斜杠或带 `%LOCALAPPDATA%` 之类的环境变量。
pub(crate) fn same_program(rule_path: &str, exe: &str) -> bool {
    fn normalize(path: &str) -> String {
        let mut expanded = String::with_capacity(path.len());
        let mut rest = path.trim();
        while let Some(start) = rest.find('%') {
            let Some(length) = rest[start + 1..].find('%') else {
                break;
            };
            let name = &rest[start + 1..start + 1 + length];
            expanded.push_str(&rest[..start]);
            match std::env::var(name) {
                Ok(value) if !name.is_empty() => expanded.push_str(&value),
                _ => expanded.push_str(&rest[start..start + length + 2]),
            }
            rest = &rest[start + length + 2..];
        }
        expanded.push_str(rest);
        expanded.replace('/', "\\").to_lowercase()
    }
    !rule_path.trim().is_empty() && normalize(rule_path) == normalize(exe)
}

/// 规则是否作用于本程序；第二个值表示是否是针对本程序的规则（修复脚本只能删这类）。
fn program_match(rule: &RuleView, exe: &str) -> (Match, bool) {
    // 限定了服务（含 `*` = 所有服务）的规则只作用于服务进程，不作用于普通桌面程序。
    if !rule.service.trim().is_empty() || rule.app_scoped {
        return (Match::No, false);
    }
    let program = rule.program.trim();
    if program.is_empty() || program.eq_ignore_ascii_case("any") {
        return (Match::Yes, false);
    }
    if same_program(program, exe) {
        (Match::Yes, true)
    } else {
        (Match::No, false)
    }
}

fn protocol_match(rule_protocol: i32, protocol: i32) -> Match {
    if rule_protocol == PROTOCOL_ANY || rule_protocol == protocol {
        Match::Yes
    } else {
        Match::No
    }
}

/// `LocalPorts`：`*`、单个端口、`a-b` 区间，或 `RPC` / `mDNS` / `Teredo` 等关键字
/// （关键字指向固定的系统端口，不会覆盖 RocketX 的端口）。
pub(crate) fn ports_match(spec: &str, port: Option<u16>) -> Match {
    if is_any(spec) {
        return Match::Yes;
    }
    let Some(port) = port else {
        return Match::Unknown;
    };
    Match::any(spec.split(',').map(|token| {
        let token = token.trim();
        let covered = match token.split_once('-') {
            Some((start, end)) => match (start.trim().parse::<u16>(), end.trim().parse::<u16>()) {
                (Ok(start), Ok(end)) => (start..=end).contains(&port),
                _ => false,
            },
            None => token.parse::<u16>().is_ok_and(|value| value == port),
        };
        if covered {
            Match::Yes
        } else {
            Match::No
        }
    }))
}

fn parse_ipv4_range(token: &str) -> Option<(u32, u32)> {
    if let Some((start, end)) = token.split_once('-') {
        let start = u32::from(start.trim().parse::<Ipv4Addr>().ok()?);
        let end = u32::from(end.trim().parse::<Ipv4Addr>().ok()?);
        return (start <= end).then_some((start, end));
    }
    if let Some((base, mask)) = token.split_once('/') {
        let base = u32::from(base.trim().parse::<Ipv4Addr>().ok()?);
        let mask = match mask.trim().parse::<u8>() {
            Ok(0) => 0,
            Ok(bits) if bits <= 32 => u32::MAX << (32 - u32::from(bits)),
            Ok(_) => return None,
            Err(_) => u32::from(mask.trim().parse::<Ipv4Addr>().ok()?),
        };
        return Some((base & mask, (base & mask) | !mask));
    }
    let single = u32::from(token.trim().parse::<Ipv4Addr>().ok()?);
    Some((single, single))
}

/// 地址列表是否覆盖某个地址。`peer` 为 `None` 表示「本地子网上某台还不知道地址的设备」。
fn address_token_match(token: &str, peer: Option<Ipv4Addr>, iface: &LanInterface) -> Match {
    let token = token.trim();
    if token == "*" {
        return Match::Yes;
    }
    if token.eq_ignore_ascii_case("LocalSubnet") {
        return match peer {
            None => Match::Yes,
            Some(peer) if iface.address.is_unspecified() => {
                // 兜底判定时没有具体网卡，只能按私网地址近似。
                if peer.is_private() {
                    Match::Yes
                } else {
                    Match::Unknown
                }
            }
            Some(peer) => {
                if iface.contains(peer) {
                    Match::Yes
                } else {
                    Match::No
                }
            }
        };
    }
    if token.contains(':') {
        // IPv6 地址/前缀覆盖不了 IPv4 连接。
        return Match::No;
    }
    match (parse_ipv4_range(token), peer) {
        (Some((start, end)), Some(peer)) => {
            if (start..=end).contains(&u32::from(peer)) {
                Match::Yes
            } else {
                Match::No
            }
        }
        // 具体地址范围，但不知道对方地址：无法判定。
        (Some(_), None) => Match::Unknown,
        // Intranet / DNS / DefaultGateway 等关键字：无法可靠判定。
        (None, _) => Match::Unknown,
    }
}

pub(crate) fn remote_match(spec: &str, peers: &[Ipv4Addr], iface: &LanInterface) -> Match {
    if is_any(spec) {
        return Match::Yes;
    }
    let peers: Vec<Option<Ipv4Addr>> = if peers.is_empty() {
        vec![None]
    } else {
        peers.iter().copied().map(Some).collect()
    };
    // 每一个对方地址都必须被某一项覆盖。
    peers.into_iter().fold(Match::Yes, |result, peer| {
        result.and(Match::any(
            spec.split(',')
                .map(|token| address_token_match(token, peer, iface)),
        ))
    })
}

fn local_match(spec: &str, iface: &LanInterface) -> Match {
    if is_any(spec) {
        return Match::Yes;
    }
    if iface.address.is_unspecified() {
        return Match::Unknown;
    }
    Match::any(spec.split(',').map(|token| {
        if token.contains(':') {
            return Match::No;
        }
        match parse_ipv4_range(token) {
            Some((start, end)) if (start..=end).contains(&u32::from(iface.address)) => Match::Yes,
            Some(_) => Match::No,
            None => Match::Unknown,
        }
    }))
}

pub(crate) fn interface_types_match(spec: &str, kind: IfKind) -> Match {
    let spec = spec.trim();
    if spec.is_empty() || spec.eq_ignore_ascii_case("all") {
        return Match::Yes;
    }
    if kind == IfKind::Other {
        return Match::Unknown;
    }
    let covered = spec.split(',').any(|token| {
        matches!(
            (kind, token.trim().to_ascii_lowercase().as_str()),
            (IfKind::Ethernet, "lan")
                | (IfKind::Wireless, "wireless")
                | (IfKind::RemoteAccess, "remoteaccess")
        )
    });
    if covered {
        Match::Yes
    } else {
        Match::No
    }
}

/// 一条规则对一次入站（某网卡、某协议、某端口）的判定；第二个值同 `program_match`。
fn rule_match(
    rule: &RuleView,
    exe: &str,
    iface: &LanInterface,
    protocol: i32,
    port: Option<u16>,
    peers: &[Ipv4Addr],
) -> (Match, bool) {
    if rule.profiles & iface.profile == 0 {
        return (Match::No, false);
    }
    let (program, specific) = program_match(rule, exe);
    if rule.allow && rule.requires_ipsec {
        return (Match::No, false);
    }
    let pinned = if rule.specific_interfaces || rule.local_users {
        Match::Unknown
    } else {
        Match::Yes
    };
    let result = program
        .and(protocol_match(rule.protocol, protocol))
        .and(ports_match(&rule.local_ports, port))
        .and(local_match(&rule.local_addresses, iface))
        .and(remote_match(&rule.remote_addresses, peers, iface))
        .and(interface_types_match(&rule.interface_types, iface.kind))
        .and(pinned);
    (result, specific)
}

/// 单块网卡、单个协议的入站判定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    /// 防火墙在该配置文件上关闭。
    Disabled,
    Allowed,
    NotAllowed,
    BlockedProgram,
    BlockedOther,
    BlockAll,
    Managed,
}

fn verdict(
    snapshot: &Snapshot,
    iface: &LanInterface,
    protocol: i32,
    port: Option<u16>,
    peers: &[Ipv4Addr],
    uncertain: &mut (u32, u32),
) -> Verdict {
    let policy = snapshot
        .policies
        .iter()
        .find(|policy| policy.profile == iface.profile)
        .copied()
        .unwrap_or(ProfilePolicy {
            profile: iface.profile,
            enabled: true,
            block_all: false,
            default_allow: false,
        });
    if !policy.enabled {
        return Verdict::Disabled;
    }
    if snapshot.modify == PolicyState::InboundBlocked {
        return Verdict::Managed;
    }
    if policy.block_all {
        return Verdict::BlockAll;
    }
    let mut allowed = policy.default_allow;
    let mut blocked_program = false;
    let mut blocked_other = false;
    for rule in &snapshot.rules {
        match rule_match(rule, &snapshot.exe, iface, protocol, port, peers) {
            (Match::Yes, specific) => {
                if rule.allow {
                    allowed = true;
                } else if specific {
                    blocked_program = true;
                } else {
                    blocked_other = true;
                }
            }
            (Match::Unknown, _) => {
                uncertain.0 += 1;
                if !rule.allow {
                    uncertain.1 += 1;
                }
            }
            (Match::No, _) => {}
        }
    }
    if blocked_other {
        Verdict::BlockedOther
    } else if blocked_program {
        Verdict::BlockedProgram
    } else if allowed {
        Verdict::Allowed
    } else if snapshot.modify == PolicyState::GroupPolicyOverride {
        Verdict::Managed
    } else {
        Verdict::NotAllowed
    }
}

fn is_physical(iface: &LanInterface) -> bool {
    matches!(iface.kind, IfKind::Ethernet | IfKind::Wireless)
}

/// 局域网实际走的网卡。
///
/// 有对方地址时：对方所在网段的网卡，其次是路由到对方的出口网卡。没有时：带网关的
/// 物理网卡（Hyper-V/WSL 的 vEthernet 通常没有网关，TUN/VPN 不算物理网卡），其次是
/// 任意物理网卡。都找不到才退回所有活动配置文件。
pub(crate) fn relevant_interfaces(
    interfaces: &[LanInterface],
    target: &Target,
) -> (Vec<LanInterface>, FirewallScope) {
    let pick = |filter: &dyn Fn(&LanInterface) -> bool| -> Vec<LanInterface> {
        interfaces
            .iter()
            .filter(|iface| filter(iface))
            .cloned()
            .collect()
    };
    if !target.peers.is_empty() {
        let containing = pick(&|iface| target.peers.iter().any(|peer| iface.contains(*peer)));
        if !containing.is_empty() {
            return (containing, FirewallScope::Peer);
        }
        let routed = pick(&|iface| target.best_interfaces.contains(&iface.index));
        if !routed.is_empty() {
            return (routed, FirewallScope::Peer);
        }
    }
    let gateway = pick(&|iface| is_physical(iface) && iface.has_gateway);
    if !gateway.is_empty() {
        return (gateway, FirewallScope::Lan);
    }
    let physical = pick(&is_physical);
    if !physical.is_empty() {
        return (physical, FirewallScope::Lan);
    }
    (Vec::new(), FirewallScope::AllProfiles)
}

/// 纯函数判定：UDP 发现与 TCP 直传在每块相关网卡上都要放行。
pub(crate) fn evaluate(snapshot: &Snapshot, target: &Target) -> FirewallStatus {
    let (mut interfaces, scope) = relevant_interfaces(&snapshot.interfaces, target);
    if scope == FirewallScope::AllProfiles {
        interfaces = [PROFILE_DOMAIN, PROFILE_PRIVATE, PROFILE_PUBLIC]
            .into_iter()
            .filter(|profile| snapshot.active_profiles & profile != 0)
            .map(|profile| LanInterface {
                index: 0,
                kind: IfKind::Other,
                address: Ipv4Addr::UNSPECIFIED,
                prefix: 0,
                has_gateway: false,
                profile,
            })
            .collect();
    }
    let profiles = interfaces
        .iter()
        .fold(0, |mask, iface| mask | iface.profile);
    let mut uncertain = (0, 0);
    let mut verdicts = Vec::new();
    for iface in &interfaces {
        for (protocol, port) in [
            (PROTOCOL_UDP, Some(DISCOVERY_PORT)),
            (PROTOCOL_TCP, target.tcp_port),
        ] {
            verdicts.push(verdict(
                snapshot,
                iface,
                protocol,
                port,
                &target.peers,
                &mut uncertain,
            ));
        }
    }
    let state = if verdicts.is_empty() {
        FirewallState::Unknown
    } else if verdicts.iter().all(|verdict| *verdict == Verdict::Disabled) {
        if snapshot.third_party.is_empty() {
            FirewallState::Ok
        } else {
            FirewallState::ThirdParty
        }
    } else {
        let worst = verdicts
            .iter()
            .map(|verdict| match verdict {
                Verdict::Disabled | Verdict::Allowed => FirewallState::Ok,
                Verdict::NotAllowed => FirewallState::MissingRule,
                Verdict::BlockedProgram => FirewallState::Blocked,
                Verdict::BlockedOther => FirewallState::BlockedOther,
                Verdict::BlockAll => FirewallState::BlockAllInbound,
                Verdict::Managed => FirewallState::Managed,
            })
            .max_by_key(|state| state.severity())
            .unwrap_or(FirewallState::Unknown);
        let some_allowed = verdicts
            .iter()
            .any(|verdict| matches!(verdict, Verdict::Allowed | Verdict::Disabled));
        // 兜底判定时拿不准哪个配置文件才是局域网的：部分放行不当成「必然失败」。
        if scope == FirewallScope::AllProfiles
            && worst == FirewallState::MissingRule
            && some_allowed
        {
            FirewallState::Partial
        } else {
            worst
        }
    };
    FirewallStatus {
        state,
        scope,
        profiles: profile_names(profiles),
        third_party: snapshot.third_party.clone(),
        uncertain_rules: uncertain.0,
        uncertain_blocks: uncertain.1,
    }
}

/// 修复脚本：先删本程序的全部入站规则（包括弹窗生成的阻止规则），再加两条放行规则。
///
/// `cmd /s /c "<script>"` 会剥掉最外层引号、保留内部引号；`&&` 比 `&` 绑定更紧，
/// 所以删除失败（本来就没有规则）不影响后续添加，而两条添加任一失败都会反映在退出码上。
pub(crate) fn repair_script(program: &str) -> Result<String, String> {
    if program.is_empty() || program.contains('"') || program.chars().any(char::is_control) {
        return Err("RocketX 程序路径无法用于防火墙规则".to_string());
    }
    Ok(format!(
        "netsh advfirewall firewall delete rule name=all dir=in program=\"{program}\" >nul 2>&1 & \
         netsh advfirewall firewall add rule name=\"{PRIVATE_RULE_NAME}\" dir=in action=allow \
         program=\"{program}\" protocol=any profile=domain,private enable=yes && \
         netsh advfirewall firewall add rule name=\"{PUBLIC_RULE_NAME}\" dir=in action=allow \
         program=\"{program}\" protocol=any profile=public remoteip=localsubnet enable=yes"
    ))
}

#[cfg(windows)]
mod platform {
    use std::net::Ipv4Addr;

    use windows::core::{Interface, BSTR, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_BUFFER_OVERFLOW, ERROR_CANCELLED, HWND, NO_ERROR, S_OK, WAIT_OBJECT_0,
    };
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GetBestInterface, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
        GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, INetFwRule, INetFwRule3, NetFwPolicy2, NET_FW_ACTION_ALLOW,
        NET_FW_MODIFY_STATE_GP_OVERRIDE, NET_FW_MODIFY_STATE_INBOUND_BLOCKED, NET_FW_PROFILE_TYPE2,
        NET_FW_RULE_DIR_IN,
    };
    use windows::Win32::Networking::NetworkListManager::{
        INetworkListManager, NetworkListManager, NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED,
        NLM_NETWORK_CATEGORY_PRIVATE,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT,
        COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Ole::IEnumVARIANT;
    use windows::Win32::System::SecurityCenter::{
        IWSCProductList, WSCProductList, WSC_SECURITY_PRODUCT_STATE_ON,
        WSC_SECURITY_PROVIDER_FIREWALL,
    };
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_DISPATCH, VT_EMPTY};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    use super::{
        evaluate, repair_script, same_program, FirewallState, FirewallStatus, IfKind, LanInterface,
        PolicyState, ProfilePolicy, RuleView, Snapshot, Target, PROFILE_DOMAIN, PROFILE_PRIVATE,
        PROFILE_PUBLIC,
    };

    /// 本线程的 COM 初始化；只有自己成功初始化时才在析构时反初始化。
    struct ComScope(bool);

    impl ComScope {
        fn new(apartment: COINIT) -> Self {
            Self(unsafe { CoInitializeEx(None, apartment) }.is_ok())
        }
    }

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    pub(super) fn exe_path() -> Result<String, String> {
        std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| format!("无法定位 RocketX 程序路径：{error}"))
    }

    fn text(value: windows::core::Result<BSTR>) -> String {
        value.map(|value| value.to_string()).unwrap_or_default()
    }

    /// 读一条入站规则；不作用于本程序的（别的程序、服务规则）尽早跳过，省掉后续属性读取。
    fn rule_view(rule: &INetFwRule, exe: &str) -> windows::core::Result<Option<RuleView>> {
        unsafe {
            if rule.Direction()? != NET_FW_RULE_DIR_IN || !rule.Enabled()?.as_bool() {
                return Ok(None);
            }
            let service = text(rule.ServiceName());
            if !service.trim().is_empty() {
                return Ok(None);
            }
            let program = text(rule.ApplicationName());
            if !program.trim().is_empty()
                && !program.trim().eq_ignore_ascii_case("any")
                && !same_program(&program, exe)
            {
                return Ok(None);
            }
            // UWP 规则：`PFN=` 不经 COM 暴露，只能看所属用户/应用包（真机验证：Microsoft
            // Store 等 30 多条规则都是这种形状）。它们不作用于桌面程序，直接跳过。
            let extended = rule.cast::<INetFwRule3>().ok();
            if let Some(extended) = &extended {
                if !text(extended.LocalAppPackageId()).trim().is_empty()
                    || !text(extended.LocalUserOwner()).trim().is_empty()
                {
                    return Ok(None);
                }
            }
            let (local_users, requires_ipsec) = match &extended {
                Some(extended) => (
                    !text(extended.LocalUserAuthorizedList()).trim().is_empty(),
                    extended.SecureFlags().unwrap_or(0) != 0
                        || !text(extended.RemoteUserAuthorizedList()).trim().is_empty()
                        || !text(extended.RemoteMachineAuthorizedList())
                            .trim()
                            .is_empty(),
                ),
                None => (false, false),
            };
            let specific_interfaces = match rule.Interfaces() {
                Ok(mut interfaces) => {
                    let empty = interfaces.Anonymous.Anonymous.vt == VT_EMPTY;
                    let _ = VariantClear(&mut interfaces);
                    !empty
                }
                Err(_) => false,
            };
            Ok(Some(RuleView {
                allow: rule.Action()? == NET_FW_ACTION_ALLOW,
                program,
                service,
                protocol: rule.Protocol()?,
                profiles: rule.Profiles()?,
                local_ports: text(rule.LocalPorts()),
                local_addresses: text(rule.LocalAddresses()),
                remote_addresses: text(rule.RemoteAddresses()),
                interface_types: text(rule.InterfaceTypes()),
                specific_interfaces,
                app_scoped: false,
                local_users,
                requires_ipsec,
            }))
        }
    }

    fn rules(policy: &INetFwPolicy2, exe: &str) -> windows::core::Result<Vec<RuleView>> {
        let mut rules = Vec::new();
        unsafe {
            let enumerator: IEnumVARIANT = policy.Rules()?._NewEnum()?.cast()?;
            loop {
                let mut items = [VARIANT::default()];
                let mut fetched = 0_u32;
                if enumerator.Next(&mut items, &mut fetched) != S_OK || fetched == 0 {
                    break;
                }
                let item = &mut items[0];
                if item.Anonymous.Anonymous.vt == VT_DISPATCH {
                    let dispatch = (*item.Anonymous.Anonymous.Anonymous.pdispVal).clone();
                    if let Some(rule) = dispatch.and_then(|value| value.cast::<INetFwRule>().ok()) {
                        // 单条规则读不出来（极少见的损坏规则）不影响整体判定。
                        if let Ok(Some(view)) = rule_view(&rule, exe) {
                            rules.push(view);
                        }
                    }
                }
                let _ = VariantClear(item);
            }
        }
        Ok(rules)
    }

    fn policies(policy: &INetFwPolicy2) -> windows::core::Result<Vec<ProfilePolicy>> {
        [PROFILE_DOMAIN, PROFILE_PRIVATE, PROFILE_PUBLIC]
            .into_iter()
            .map(|profile| unsafe {
                let kind = NET_FW_PROFILE_TYPE2(profile);
                Ok(ProfilePolicy {
                    profile,
                    enabled: policy.get_FirewallEnabled(kind)?.as_bool(),
                    block_all: policy.get_BlockAllInboundTraffic(kind)?.as_bool(),
                    default_allow: policy.get_DefaultInboundAction(kind)? == NET_FW_ACTION_ALLOW,
                })
            })
            .collect()
    }

    /// 网卡 GUID（大写、无花括号）→ 防火墙配置文件位。没连上任何网络的网卡按公用处理，
    /// 与 Windows 对「未识别的网络」的归类一致。
    fn adapter_profiles() -> Vec<(String, i32)> {
        let read = || -> windows::core::Result<Vec<(String, i32)>> {
            let mut result = Vec::new();
            unsafe {
                let manager: INetworkListManager =
                    CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL)?;
                let connections = manager.GetNetworkConnections()?;
                loop {
                    let mut items = [None];
                    let mut fetched = 0_u32;
                    if connections.Next(&mut items, Some(&mut fetched)).is_err() || fetched == 0 {
                        break;
                    }
                    let Some(connection) = items[0].take() else {
                        continue;
                    };
                    let category = connection.GetNetwork()?.GetCategory()?;
                    let profile = if category == NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED {
                        PROFILE_DOMAIN
                    } else if category == NLM_NETWORK_CATEGORY_PRIVATE {
                        PROFILE_PRIVATE
                    } else {
                        PROFILE_PUBLIC
                    };
                    result.push((format!("{:?}", connection.GetAdapterId()?), profile));
                }
            }
            Ok(result)
        };
        read().unwrap_or_default()
    }

    fn interfaces() -> Vec<LanInterface> {
        let profiles = adapter_profiles();
        let flags = GAA_FLAG_INCLUDE_GATEWAYS
            | GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 16 * 1024_u32;
        let mut buffer: Vec<u64>;
        loop {
            buffer = vec![0_u64; (size as usize).div_ceil(8)];
            let status = unsafe {
                GetAdaptersAddresses(
                    u32::from(AF_INET.0),
                    flags,
                    None,
                    Some(buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>()),
                    &mut size,
                )
            };
            if status == ERROR_BUFFER_OVERFLOW.0 {
                continue;
            }
            if status != NO_ERROR.0 {
                return Vec::new();
            }
            break;
        }
        let mut result = Vec::new();
        let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while let Some(current) = unsafe { adapter.as_ref() } {
            adapter = current.Next;
            if current.OperStatus != IfOperStatusUp || current.IfType == 24 {
                continue;
            }
            let guid = unsafe { current.AdapterName.to_string() }
                .unwrap_or_default()
                .trim_matches(|c| c == '{' || c == '}')
                .to_ascii_uppercase();
            let profile = profiles
                .iter()
                .find(|(id, _)| id.eq_ignore_ascii_case(&guid))
                .map(|(_, profile)| *profile)
                .unwrap_or(PROFILE_PUBLIC);
            let index = unsafe { current.Anonymous1.Anonymous.IfIndex };
            let has_gateway = !current.FirstGatewayAddress.is_null();
            let mut unicast = current.FirstUnicastAddress;
            while let Some(address) = unsafe { unicast.as_ref() } {
                unicast = address.Next;
                let sockaddr = address.Address.lpSockaddr;
                if sockaddr.is_null() || unsafe { (*sockaddr).sa_family } != AF_INET {
                    continue;
                }
                let sin = unsafe { &*sockaddr.cast::<SOCKADDR_IN>() };
                let ip = Ipv4Addr::from(unsafe { sin.sin_addr.S_un.S_addr }.to_ne_bytes());
                if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
                    continue;
                }
                result.push(LanInterface {
                    index,
                    kind: IfKind::from_if_type(current.IfType),
                    address: ip,
                    prefix: address.OnLinkPrefixLength,
                    has_gateway,
                    profile,
                });
            }
        }
        result
    }

    /// Windows 安全中心登记的、处于开启状态的防火墙产品（第三方）。
    ///
    /// Windows 自带防火墙也会出现在列表里（中文系统名为「Windows 防火墙」），它的
    /// `ProductGuid` 是字面量 `NULL`（真机验证）；第三方产品都有真实 GUID。按 GUID 区分，
    /// 不依赖本地化名称。
    fn third_party_firewalls() -> Vec<String> {
        let read = || -> windows::core::Result<Vec<String>> {
            unsafe {
                let list: IWSCProductList =
                    CoCreateInstance(&WSCProductList, None, CLSCTX_INPROC_SERVER)?;
                list.Initialize(WSC_SECURITY_PROVIDER_FIREWALL)?;
                let mut names = Vec::new();
                for index in 0..list.Count()?.max(0) as u32 {
                    let product = list.get_Item(index)?;
                    let guid = product
                        .ProductGuid()
                        .map(|guid| guid.to_string())
                        .unwrap_or_default();
                    let is_windows =
                        guid.trim().is_empty() || guid.trim().eq_ignore_ascii_case("NULL");
                    if !is_windows && product.ProductState()? == WSC_SECURITY_PRODUCT_STATE_ON {
                        let name = product.ProductName()?.to_string();
                        if !name.trim().is_empty() {
                            names.push(name);
                        }
                    }
                }
                Ok(names)
            }
        };
        read().unwrap_or_default()
    }

    fn best_interfaces(peers: &[Ipv4Addr]) -> Vec<u32> {
        peers
            .iter()
            .filter_map(|peer| {
                let mut index = 0_u32;
                let status =
                    unsafe { GetBestInterface(u32::from_ne_bytes(peer.octets()), &mut index) };
                (status == NO_ERROR.0).then_some(index)
            })
            .collect()
    }

    fn snapshot(exe: &str) -> windows::core::Result<Snapshot> {
        unsafe {
            let policy: INetFwPolicy2 =
                CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
            let modify = policy.LocalPolicyModifyState()?;
            Ok(Snapshot {
                exe: exe.to_string(),
                policies: policies(&policy)?,
                modify: if modify == NET_FW_MODIFY_STATE_INBOUND_BLOCKED {
                    PolicyState::InboundBlocked
                } else if modify == NET_FW_MODIFY_STATE_GP_OVERRIDE {
                    PolicyState::GroupPolicyOverride
                } else {
                    PolicyState::Local
                },
                rules: rules(&policy, exe)?,
                interfaces: interfaces(),
                active_profiles: policy.CurrentProfileTypes()?,
                third_party: third_party_firewalls(),
            })
        }
    }

    pub(crate) fn status_for(
        exe: &str,
        peers: Vec<Ipv4Addr>,
        tcp_port: Option<u16>,
    ) -> FirewallStatus {
        let _com = ComScope::new(COINIT_MULTITHREADED);
        let target = Target {
            best_interfaces: best_interfaces(&peers),
            peers,
            tcp_port,
        };
        match snapshot(exe) {
            Ok(snapshot) => evaluate(&snapshot, &target),
            Err(error) => {
                log::warn!(
                    target: crate::LAN_LOG_TARGET,
                    "LAN firewall status unavailable: hresult={:#x}",
                    error.code().0
                );
                FirewallStatus::bare(FirewallState::Unknown)
            }
        }
    }

    /// 通过一次 UAC 提权执行修复脚本。用户拒绝提权时返回 `Err("cancelled")`。
    pub fn repair(owner: Option<isize>) -> Result<(), String> {
        let _com = ComScope::new(COINIT_APARTMENTTHREADED);
        let script = repair_script(&exe_path()?)?;
        let verb = HSTRING::from("runas");
        let file = HSTRING::from("cmd.exe");
        let parameters = HSTRING::from(format!("/d /s /c \"{script}\""));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            hwnd: HWND(owner.unwrap_or_default() as *mut _),
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            nShow: 0, // SW_HIDE：不闪控制台窗口
            ..Default::default()
        };
        if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
            if error.code() == ERROR_CANCELLED.to_hresult() {
                return Err("cancelled".to_string());
            }
            return Err(format!("无法以管理员身份运行防火墙修复：{error}"));
        }
        if info.hProcess.is_invalid() {
            return Err("防火墙修复进程没有启动".to_string());
        }
        let mut exit_code = 1_u32;
        let waited = unsafe { WaitForSingleObject(info.hProcess, 60_000) };
        let read = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
        unsafe {
            let _ = CloseHandle(info.hProcess);
        }
        if waited != WAIT_OBJECT_0 {
            return Err("防火墙修复超时".to_string());
        }
        read.map_err(|error| format!("无法读取防火墙修复结果：{error}"))?;
        if exit_code != 0 {
            return Err(format!("netsh 添加防火墙规则失败（退出码 {exit_code}）"));
        }
        Ok(())
    }
}

/// 判定本机防火墙对 RocketX 局域网入站的放行情况（只读，无需提权）。
#[cfg(windows)]
pub fn lan_firewall_status(peers: Vec<Ipv4Addr>, tcp_port: Option<u16>) -> FirewallStatus {
    match platform::exe_path() {
        Ok(exe) => platform::status_for(&exe, peers, tcp_port),
        Err(_) => FirewallStatus::bare(FirewallState::Unknown),
    }
}

#[cfg(not(windows))]
pub fn lan_firewall_status(_peers: Vec<Ipv4Addr>, _tcp_port: Option<u16>) -> FirewallStatus {
    FirewallStatus::bare(FirewallState::Unsupported)
}

#[cfg(windows)]
fn repair_firewall(owner: Option<isize>) -> Result<(), String> {
    platform::repair(owner)
}

#[cfg(not(windows))]
fn repair_firewall(_owner: Option<isize>) -> Result<(), String> {
    Err("仅 Windows 需要修复防火墙".to_string())
}

fn log_status(status: &FirewallStatus) {
    log::info!(
        target: crate::LAN_LOG_TARGET,
        "LAN firewall status: state={} scope={} profiles={} uncertain_rules={} uncertain_blocks={} third_party={}",
        status.state.as_str(),
        status.scope.as_str(),
        status.profiles.join(","),
        status.uncertain_rules,
        status.uncertain_blocks,
        status.third_party.len()
    );
}

/// 用户点击 P2P 直传时调用（只读，无需提权）。`user_id` 是对方，用来定位局域网网卡。
#[tauri::command]
pub async fn lan_firewall_check(
    runtime: tauri::State<'_, crate::lan::LanRuntimeState>,
    user_id: Option<String>,
) -> Result<FirewallStatus, String> {
    let (tcp_port, peers) = crate::lan::firewall_target(&runtime, user_id.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let status = lan_firewall_status(peers, tcp_port);
        log_status(&status);
        status
    })
    .await
    .map_err(|error| format!("防火墙检查任务失败：{error}"))
}

/// 点击 P2P 直传且本机入站被挡时调用：弹一次 UAC，删除本程序的阻止规则并添加放行规则。
#[tauri::command]
pub async fn lan_firewall_repair(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, crate::lan::LanRuntimeState>,
    user_id: Option<String>,
) -> Result<FirewallStatus, String> {
    #[cfg(windows)]
    let owner = window.hwnd().ok().map(|hwnd| hwnd.0 as isize);
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        None
    };
    let (tcp_port, peers) = crate::lan::firewall_target(&runtime, user_id.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let result = repair_firewall(owner);
        log::info!(
            target: crate::LAN_LOG_TARGET,
            "LAN firewall repair: outcome={}",
            match &result {
                Ok(()) => "applied",
                Err(error) if error == "cancelled" => "cancelled",
                Err(_) => "failed",
            }
        );
        result?;
        let status = lan_firewall_status(peers, tcp_port);
        log_status(&status);
        Ok(status)
    })
    .await
    .map_err(|error| format!("防火墙修复任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "C:\\Users\\someone\\AppData\\Local\\RocketX\\rocketx.exe";
    const PEER: Ipv4Addr = Ipv4Addr::new(192, 168, 0, 20);
    const TCP_PORT: u16 = 51_234;

    fn wlan(profile: i32) -> LanInterface {
        LanInterface {
            index: 7,
            kind: IfKind::Wireless,
            address: Ipv4Addr::new(192, 168, 0, 119),
            prefix: 24,
            has_gateway: true,
            profile,
        }
    }

    /// 本机现场：sing-box TUN，公用网络，/30。
    fn tun() -> LanInterface {
        LanInterface {
            index: 30,
            kind: IfKind::Other,
            address: Ipv4Addr::new(172, 18, 0, 1),
            prefix: 30,
            has_gateway: true,
            profile: PROFILE_PUBLIC,
        }
    }

    /// Hyper-V / WSL 的 vEthernet：以太网类型、公用网络、没有网关。
    fn vethernet() -> LanInterface {
        LanInterface {
            index: 40,
            kind: IfKind::Ethernet,
            address: Ipv4Addr::new(172, 26, 16, 1),
            prefix: 20,
            has_gateway: false,
            profile: PROFILE_PUBLIC,
        }
    }

    fn policy(profile: i32) -> ProfilePolicy {
        ProfilePolicy {
            profile,
            enabled: true,
            block_all: false,
            default_allow: false,
        }
    }

    fn snapshot(interfaces: Vec<LanInterface>, rules: Vec<RuleView>) -> Snapshot {
        Snapshot {
            exe: EXE.to_string(),
            policies: vec![
                policy(PROFILE_DOMAIN),
                policy(PROFILE_PRIVATE),
                policy(PROFILE_PUBLIC),
            ],
            modify: PolicyState::Local,
            rules,
            interfaces,
            active_profiles: PROFILE_PRIVATE | PROFILE_PUBLIC,
            third_party: Vec::new(),
        }
    }

    /// 「允许访问」弹窗生成的规则形状：按程序、单协议、端口/地址不限。
    fn app_rule(allow: bool, profiles: i32, protocol: i32) -> RuleView {
        RuleView {
            allow,
            program: EXE.to_lowercase(),
            protocol,
            profiles,
            local_ports: "*".into(),
            local_addresses: "*".into(),
            remote_addresses: "*".into(),
            interface_types: "All".into(),
            ..Default::default()
        }
    }

    fn allow_both(profiles: i32) -> Vec<RuleView> {
        vec![
            app_rule(true, profiles, PROTOCOL_TCP),
            app_rule(true, profiles, PROTOCOL_UDP),
        ]
    }

    fn target() -> Target {
        Target {
            peers: vec![PEER],
            best_interfaces: Vec::new(),
            tcp_port: Some(TCP_PORT),
        }
    }

    fn state(snapshot: &Snapshot, target: &Target) -> FirewallState {
        evaluate(snapshot, target).state
    }

    #[test]
    fn no_rules_means_inbound_is_blocked_by_default() {
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], Vec::new());
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
    }

    #[test]
    fn prompt_rules_for_the_lan_profile_allow_p2p() {
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], allow_both(PROFILE_PRIVATE));
        let status = evaluate(&snap, &target());
        assert_eq!(status.state, FirewallState::Ok);
        assert_eq!(status.scope, FirewallScope::Peer);
        assert_eq!(status.profiles, vec!["private"]);
    }

    #[test]
    fn prompt_generated_block_rule_beats_any_allow_rule() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules.push(app_rule(false, PROFILE_PRIVATE, PROTOCOL_UDP));
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::Blocked);
    }

    #[test]
    fn tcp_and_udp_must_both_be_allowed() {
        let snap = snapshot(
            vec![wlan(PROFILE_PRIVATE)],
            vec![app_rule(true, PROFILE_PRIVATE, PROTOCOL_TCP)],
        );
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
    }

    #[test]
    fn only_the_lan_interface_profile_matters_not_the_tun() {
        // 本机现场：WLAN 专用 + TUN 公用。公用网络上的阻止规则与缺失规则都不影响局域网。
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules.push(app_rule(false, PROFILE_PUBLIC, PROTOCOL_ANY));
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE), tun()], rules);
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
        // 还没发现对方时，按带网关的物理网卡判断，TUN 同样被排除。
        let unknown_peer = Target {
            peers: Vec::new(),
            ..target()
        };
        let status = evaluate(&snap, &unknown_peer);
        assert_eq!(status.state, FirewallState::Ok);
        assert_eq!(status.scope, FirewallScope::Lan);
    }

    #[test]
    fn public_wired_lan_is_not_hidden_by_a_private_wifi() {
        // 旧实现按所有活动配置文件的并集判断，这种情况只会报「部分放行」而不请求授权。
        let wired = LanInterface {
            index: 3,
            kind: IfKind::Ethernet,
            address: Ipv4Addr::new(10, 1, 2, 30),
            prefix: 24,
            has_gateway: true,
            profile: PROFILE_PUBLIC,
        };
        let snap = snapshot(
            vec![wlan(PROFILE_PRIVATE), wired],
            allow_both(PROFILE_PRIVATE),
        );
        let peer_on_wire = Target {
            peers: vec![Ipv4Addr::new(10, 1, 2, 40)],
            ..target()
        };
        assert_eq!(state(&snap, &peer_on_wire), FirewallState::MissingRule);
    }

    #[test]
    fn vethernet_without_gateway_is_not_treated_as_the_lan() {
        let snap = snapshot(
            vec![vethernet(), wlan(PROFILE_PRIVATE)],
            allow_both(PROFILE_PRIVATE),
        );
        let unknown_peer = Target {
            peers: Vec::new(),
            ..target()
        };
        assert_eq!(state(&snap, &unknown_peer), FirewallState::Ok);
    }

    #[test]
    fn routed_peer_uses_the_best_interface() {
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], allow_both(PROFILE_PRIVATE));
        let routed = Target {
            peers: vec![Ipv4Addr::new(10, 9, 9, 9)],
            best_interfaces: vec![7],
            tcp_port: Some(TCP_PORT),
        };
        let status = evaluate(&snap, &routed);
        assert_eq!(status.scope, FirewallScope::Peer);
        assert_eq!(status.state, FirewallState::Ok);
    }

    #[test]
    fn block_all_inbound_overrides_every_allow_rule() {
        let mut snap = snapshot(vec![wlan(PROFILE_PRIVATE)], allow_both(PROFILE_PRIVATE));
        snap.policies[1].block_all = true;
        assert_eq!(state(&snap, &target()), FirewallState::BlockAllInbound);
    }

    #[test]
    fn default_allow_inbound_needs_no_rule() {
        let mut snap = snapshot(vec![wlan(PROFILE_PRIVATE)], Vec::new());
        snap.policies[1].default_allow = true;
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn generic_port_block_rule_cannot_be_fixed_by_the_repair_script() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules.push(RuleView {
            program: String::new(),
            local_ports: "45826".into(),
            ..app_rule(false, PROFILE_PRIVATE, PROTOCOL_UDP)
        });
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::BlockedOther);
    }

    #[test]
    fn generic_port_rules_count_as_allow() {
        // IT 放行了发现端口与全部 TCP（不带程序路径）。
        let udp = RuleView {
            program: String::new(),
            local_ports: "45826".into(),
            ..app_rule(true, PROFILE_PRIVATE, PROTOCOL_UDP)
        };
        let tcp = RuleView {
            program: String::new(),
            ..app_rule(true, PROFILE_PRIVATE, PROTOCOL_TCP)
        };
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], vec![udp, tcp]);
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn port_scoped_allow_rule_that_misses_our_port_does_not_count() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules[0].local_ports = "80,443".into();
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
    }

    #[test]
    fn remote_address_restrictions_are_respected() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules[0].remote_addresses = "10.0.0.0/8".into();
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);

        let mut rules = allow_both(PROFILE_PRIVATE);
        rules[0].remote_addresses = "LocalSubnet".into();
        rules[1].remote_addresses = "192.168.0.0/255.255.255.0".into();
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn interface_type_restrictions_are_respected() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules[0].interface_types = "Lan".into();
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules.clone());
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
        rules[0].interface_types = "Lan,Wireless".into();
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn service_scoped_and_other_program_rules_do_not_apply() {
        let mut service = app_rule(false, PROFILE_PRIVATE, PROTOCOL_ANY);
        service.program = String::new();
        service.service = "*".into();
        let mut other = app_rule(false, PROFILE_PRIVATE, PROTOCOL_ANY);
        other.program = "C:\\Windows\\System32\\svchost.exe".into();
        let mut rules = allow_both(PROFILE_PRIVATE);
        rules.extend([service, other]);
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn undecidable_rules_are_counted_but_neither_allow_nor_block() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        let mut odd = app_rule(false, PROFILE_PRIVATE, PROTOCOL_ANY);
        odd.remote_addresses = "Intranet".into();
        let mut pinned = app_rule(false, PROFILE_PRIVATE, PROTOCOL_ANY);
        pinned.specific_interfaces = true;
        rules.extend([odd, pinned]);
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        let status = evaluate(&snap, &target());
        assert_eq!(status.state, FirewallState::Ok);
        assert!(status.uncertain_rules >= 2);
        assert_eq!(
            status.uncertain_rules, status.uncertain_blocks,
            "两条都是阻止规则"
        );
    }

    #[test]
    fn uwp_rules_without_a_program_path_do_not_apply_to_desktop_apps() {
        // 真机现场：Microsoft Store 等 UWP 规则的 ApplicationName 为空、任意协议/端口/地址，
        // 旧判定把它们当成「对所有程序放行」，没有任何规则的程序也被判成已放行。
        let mut store_allow = app_rule(true, PROFILE_PRIVATE, PROTOCOL_ANY);
        store_allow.program = String::new();
        store_allow.app_scoped = true;
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], vec![store_allow.clone()]);
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);

        let mut store_block = store_allow;
        store_block.allow = false;
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], {
            let mut rules = allow_both(PROFILE_PRIVATE);
            rules.push(store_block);
            rules
        });
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn ipsec_only_allow_rules_do_not_cover_plain_p2p() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        for rule in &mut rules {
            rule.requires_ipsec = true;
        }
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
    }

    #[test]
    fn user_scoped_rules_are_undecidable() {
        let mut rules = allow_both(PROFILE_PRIVATE);
        for rule in &mut rules {
            rule.local_users = true;
        }
        let snap = snapshot(vec![wlan(PROFILE_PRIVATE)], rules);
        let status = evaluate(&snap, &target());
        assert_eq!(status.state, FirewallState::MissingRule);
        assert_eq!(status.uncertain_rules, 2);
        assert_eq!(
            status.uncertain_blocks, 0,
            "判定不了的放行规则不会是连不上的原因"
        );
    }

    #[test]
    fn tcp_port_scoped_rule_is_undecidable_without_a_running_listener() {
        assert_eq!(ports_match("51234", None), Match::Unknown);
        assert_eq!(ports_match("*", None), Match::Yes);
        assert_eq!(ports_match("50000-52000", Some(TCP_PORT)), Match::Yes);
        assert_eq!(ports_match("RPC,445", Some(TCP_PORT)), Match::No);
    }

    #[test]
    fn remote_address_parsing_covers_windows_formats() {
        let iface = wlan(PROFILE_PRIVATE);
        for spec in [
            "*",
            "LocalSubnet",
            "192.168.0.20",
            "192.168.0.0/24",
            "192.168.0.0/255.255.255.0",
            "192.168.0.1-192.168.0.50",
            "fe80::/64,192.168.0.0/16",
        ] {
            assert_eq!(remote_match(spec, &[PEER], &iface), Match::Yes, "{spec}");
        }
        for spec in ["10.0.0.0/8", "192.168.1.0/24", "fe80::/64"] {
            assert_eq!(remote_match(spec, &[PEER], &iface), Match::No, "{spec}");
        }
        assert_eq!(remote_match("Intranet", &[PEER], &iface), Match::Unknown);
        // 不知道对方地址时，只有「任意」与「本地子网」能确定覆盖。
        assert_eq!(remote_match("LocalSubnet", &[], &iface), Match::Yes);
        assert_eq!(remote_match("192.168.0.0/24", &[], &iface), Match::Unknown);
    }

    #[test]
    fn firewall_disabled_is_ok_unless_a_third_party_took_over() {
        let mut snap = snapshot(vec![wlan(PROFILE_PRIVATE)], Vec::new());
        snap.policies[1].enabled = false;
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
        snap.third_party = vec!["火绒安全".into()];
        let status = evaluate(&snap, &target());
        assert_eq!(status.state, FirewallState::ThirdParty);
        assert_eq!(status.third_party, vec!["火绒安全".to_string()]);
    }

    #[test]
    fn group_policy_takes_over_when_local_rules_do_not_help() {
        let mut snap = snapshot(vec![wlan(PROFILE_DOMAIN)], allow_both(PROFILE_DOMAIN));
        snap.modify = PolicyState::InboundBlocked;
        assert_eq!(state(&snap, &target()), FirewallState::Managed);
        let mut snap = snapshot(vec![wlan(PROFILE_DOMAIN)], Vec::new());
        snap.modify = PolicyState::GroupPolicyOverride;
        assert_eq!(state(&snap, &target()), FirewallState::Managed);
        let mut snap = snapshot(vec![wlan(PROFILE_DOMAIN)], allow_both(PROFILE_DOMAIN));
        snap.modify = PolicyState::GroupPolicyOverride;
        assert_eq!(state(&snap, &target()), FirewallState::Ok);
    }

    #[test]
    fn falls_back_to_active_profiles_when_no_interface_is_known() {
        let snap = snapshot(Vec::new(), allow_both(PROFILE_PRIVATE));
        let status = evaluate(&snap, &target());
        assert_eq!(status.scope, FirewallScope::AllProfiles);
        assert_eq!(status.state, FirewallState::Partial);
        let snap = snapshot(Vec::new(), Vec::new());
        assert_eq!(state(&snap, &target()), FirewallState::MissingRule);
    }

    #[test]
    fn program_paths_match_case_separator_and_environment_insensitively() {
        assert!(same_program(
            "c:\\users\\lus\\appdata\\local\\rocketx\\rocketx.exe",
            "C:\\Users\\lus\\AppData\\Local\\RocketX\\rocketx.exe"
        ));
        assert!(same_program(
            "C:/Apps/RocketX/rocketx.exe",
            "C:\\Apps\\RocketX\\rocketx.exe"
        ));
        assert!(!same_program("", "C:\\Apps\\RocketX\\rocketx.exe"));
        std::env::set_var(
            "RCX_FIREWALL_TEST_ROOT",
            "C:\\Users\\someone\\AppData\\Local",
        );
        assert!(same_program(
            "%RCX_FIREWALL_TEST_ROOT%\\RocketX\\rocketx.exe",
            EXE
        ));
    }

    #[test]
    fn repair_script_removes_block_rules_before_adding_allow_rules() {
        let script = repair_script("C:\\Program Files\\RocketX\\rocketx.exe").unwrap();
        let delete = script.find("delete rule name=all dir=in").unwrap();
        let add = script.find("add rule").unwrap();
        assert!(delete < add, "必须先删阻止规则：阻止规则优先于放行规则");
        assert!(script.contains("program=\"C:\\Program Files\\RocketX\\rocketx.exe\""));
        assert!(script.contains("profile=domain,private"));
        assert!(script.contains("profile=public remoteip=localsubnet"));
        assert!(repair_script("C:\\a\"b\\rocketx.exe").is_err());
        assert!(repair_script("").is_err());
    }

    /// 现场核对：读取本机真实防火墙策略、网卡与安全中心。
    #[cfg(windows)]
    #[test]
    #[ignore = "reads the real Windows firewall policy of this machine"]
    fn live_status_reads_this_machine() {
        let installed = std::path::Path::new(&std::env::var("LOCALAPPDATA").unwrap())
            .join("RocketX")
            .join("rocketx.exe")
            .to_string_lossy()
            .into_owned();
        for peers in [Vec::new(), vec![Ipv4Addr::new(192, 168, 0, 20)]] {
            let status = platform::status_for(&installed, peers.clone(), Some(TCP_PORT));
            println!("installed peers={peers:?} status={status:?}");
            assert_ne!(status.state, FirewallState::Unknown);
        }
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        println!(
            "test-binary status={:?}",
            platform::status_for(&exe, Vec::new(), None)
        );
    }

    /// 现场核对修复脚本：只动测试二进制自己的规则，结束时全部删除。
    /// 需要已提权的终端（正式路径由 UAC 提权），会真实修改本机防火墙。
    #[cfg(windows)]
    #[test]
    #[ignore = "requires an elevated shell; temporarily edits firewall rules of the test binary"]
    fn live_repair_script_clears_prompt_block_rules() {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let cleanup = || {
            let _ = Command::new("netsh")
                .args([
                    "advfirewall",
                    "firewall",
                    "delete",
                    "rule",
                    "name=all",
                    "dir=in",
                ])
                .arg(format!("program={exe}"))
                .output();
        };
        cleanup();
        let added = Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "add",
                "rule",
                "name=rcx-live-block",
                "dir=in",
            ])
            .args(["action=block", "protocol=udp", "profile=any"])
            .arg(format!("program={exe}"))
            .output()
            .unwrap();
        assert!(added.status.success(), "需要已提权的终端");
        let blocked = platform::status_for(&exe, Vec::new(), Some(TCP_PORT));
        let repaired = Command::new("cmd.exe")
            .raw_arg(format!("/d /s /c \"{}\"", repair_script(&exe).unwrap()))
            .output()
            .unwrap();
        let after = platform::status_for(&exe, Vec::new(), Some(TCP_PORT));
        cleanup();
        println!(
            "blocked={blocked:?} repair_exit={:?} after={after:?}",
            repaired.status.code()
        );
        assert_eq!(blocked.state, FirewallState::Blocked);
        assert!(repaired.status.success());
        assert_eq!(after.state, FirewallState::Ok);
    }
}
