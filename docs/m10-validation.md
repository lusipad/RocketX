# M10 验收记录

日期：2026-07-17
版本：v0.19.0

> 当前实现已迁移到 `plugins/intranet-link/native` Sidecar；以下 v0.19.0 结果保留为历史验收证据。
> 复跑命令中的 Cargo 清单应改为 `plugins/intranet-link/native/Cargo.toml`。

## 交付边界

- 默认关闭、用户显式开启的 IP Messenger 共存模式；固定 UDP/TCP 2425。
- 独立本地虚拟频道、在线联系人选择、消息与普通文件收发、「今日」收件箱接入。
- IPMSG peer 始终是未认证旧协议身份，不复用 M9 可信 LAN。
- 飞秋仅验证公开 GBK 报文 fixture；不声明其未签名二进制的真实运行时兼容。

## 官方客户端

- 客户端：IP Messenger for Windows 5.8.3 x64，官方签名安装器解包运行。
- 安装器 SHA-256：`13C85CC9EB55AB80B3A1C55462708CAAF454F4ECC89B036112BE9BBA30449276`。
- 签名：Authenticode 有效，签名者 FastCopy Lab, LLC。
- 隔离地址：RocketX `127.0.0.1:2425`，官方客户端 `/NIC 127.0.0.2`。

真实验收测试使用官方 `IPMsg.exe` 与 `ipcmd.exe`，不是自写对端：

```powershell
$env:ROCKETX_IPMSG_OFFICIAL_DIR='<官方 5.8.3 解包目录>'
cargo test --manifest-path plugins/intranet-link/native/Cargo.toml --locked `
  official_ipmsg_5x_message_and_file_interoperate -- `
  --ignored --test-threads=1
```

结果：官方客户端发现 RocketX；RocketX 与官方客户端双向普通消息均收到 `RECVMSG`；官方发送的
1,146,880 字节文件由 RocketX 通过 TCP 2425 拉取，最终字节逐一相等。验收同时发现并覆盖
5.8.3 `ipcmd` 数字文件 ID 与旧十六进制字段的歧义，以及官方延迟发送队列的陈旧重试包。

## 自动验证

- Rust：完整套件 30 passed、1 ignored；其中 IPMSG 6 passed，覆盖 UTF-8、CP932/GBK fixture、
  畸形包拒绝、路径穿越拒绝、UDP ACK 重试停止、真实 TCP 文件字节流。官方 5.8.3 验收测试
  默认 ignored，显式运行通过。
- Web typecheck：通过。
- 纯函数：219 passed。
- 回归：235 passed，包含 IPMSG 消息进入「今日」且只收录入站消息。
- 真实 Rocket.Chat smoke：53 passed；分类集成：5 passed。
- Web production 与 Windows Tauri release：通过。`rocketx.exe` 为 15,874,560 字节，
  FileVersion/ProductVersion 均为 `0.19.0`，SHA-256 为
  `24A9FA23954B2E45B12EC32971D1647FCD309888FF592629D2C914C73AA951E2`。
- 桌面发布二进制启动成功，复用真实登录态进入主界面，消息列表与设置入口正常渲染。首次运行
  出现 Windows 防火墙授权提示；验收未代替用户修改该系统权限。

独立的 `codex:protocol:check` 仍会报告仓库中既有的 pinned Codex 生成树漂移；M10 未修改该生成树，
CI 也未把此命令列为 M10 门禁。该项归入 M11 发布收口统一再生成与验证，避免把无关的大型生成差异
混入 IPMSG 兼容版本。
