//! Windows 防火墙入站放行（issue #369：两台 Windows 互相发现不到）。
//!
//! LAN 发现依赖 UDP 45826（mDNS/局域网广播）与随机的 TCP 监听端口。Windows
//! 防火墙默认拦截这两类入站，且 Tauri 应用联网不会像浏览器那样弹出「允许
//! 访问」对话框——于是即使两台设备 ping 得通，peer 表仍然为空（no LAN peer
//! is online）。CI/Linux 环境防火墙行为不同，因此该问题只在真实 Windows
//! 复测时才暴露。
//!
//! 实现：用 netsh advfirewall 添加「程序级」入站放行规则。
//! - 程序级规则覆盖该程序所有端口（TCP 监听端口是随机的，端口级规则无法覆盖）；
//! - 仅限「域 + 专用」网络配置文件，公用网络不放行（安全优先）；
//! - 幂等：同名规则已存在则直接返回；
//! - 失败不阻断：返回 Err，由调用方降级为日志/提示（第三方安全软件可能拦截）。

use std::process::Command;

/// 规则名（跨平台常量，供测试与日志引用）。
fn rule_name() -> &'static str {
    "RocketX LAN P2P (inbound, private networks)"
}

#[cfg(windows)]
fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("current exe: {error}"))
}

#[cfg(windows)]
fn rule_exists() -> Result<bool, String> {
    let output = Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule", "name=all"])
        .output()
        .map_err(|error| format!("netsh show failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "netsh show exited {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // 规则名出现在输出中即视为已存在（程序路径可能因升级变化，需按程序路径再核）
    Ok(text.contains(rule_name()))
}

#[cfg(not(windows))]
pub fn ensure_lan_firewall_rule() -> Result<(), String> {
    Ok(())
}

/// 对外入口：幂等确认放行；失败返回 Err（调用方决定是否降级）。
#[cfg(windows)]
pub fn ensure_lan_firewall_rule() -> Result<(), String> {
    let program = exe_path()?;
    let name = rule_name();
    if rule_exists()? {
        return Ok(());
    }
    let output = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={name}"),
            "dir=in",
            "action=allow",
            "protocol=any",
            &format!("program={program}"),
            // 1 + 2 = 域 + 专用网络配置文件；不开放公用网络
            "profile=domain,private",
        ])
        .output()
        .map_err(|error| format!("netsh add failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "netsh advfirewall add exited {}: {}",
        output.status.code().unwrap_or(-1),
        stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rule_name_is_stable_for_idempotence() {
        let name = super::rule_name();
        assert!(!name.is_empty());
        assert!(name.contains("RocketX"));
    }
}
