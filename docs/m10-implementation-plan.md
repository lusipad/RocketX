# M10 实施计划：IPMSG 共存模式

状态：已按 v0.19.0 实现；验收证据见 [`m10-validation.md`](m10-validation.md)。

日期：2026-07-17；前置证据见 [`m10-spike-b.md`](m10-spike-b.md)。

## 1. 最可能调整的决定

### 1.1 兼容承诺

**决定**：v0.19.0 的硬承诺是官方 IP Messenger 5.x 双向普通消息与文件；飞秋只承诺
已公开报文 fixture 的解析兼容，不声称真实客户端验收。

- 信心：高
- 会推翻它的证据：得到有可信签名或可在隔离 VM 中扫描、运行的真实飞秋版本，并完成消息/文件抓包。

### 1.2 信任与启用方式

**决定**：IPMSG 是“旧协议未认证 peer”，与 M9 的 Ed25519 固定公钥可信 LAN 完全分区。
桌面设置中显式开启后才绑定 UDP/TCP 2425；默认关闭。附件只展示 offer，用户点击后才下载，
下载完成也不自动打开。

- 信心：高
- 会推翻它的证据：M10 同时实现并真实验收原版 RSA/AES 指纹身份，且能给出向后兼容迁移策略。

### 1.3 本地频道模型

**决定**：使用一个保留 rid `local:ipmsg` 的「局域网」虚拟频道，但不伪造 Rocket.Chat
subscription。`ConversationList` 合入一个本地 conversation；`ChatArea` 对该 rid 进入专用头部和
composer，消息仍复用 `RcMessage` / `MessageList` 渲染。当前发送目标由 peer 选择器显式指定。

- 信心：高
- 会推翻它的证据：现有消息渲染对本地附件无法在不污染 RC API 路由的情况下复用。

### 1.4 Native API 与事件

Rust `ipmsg.rs` 提供以下最小表面：

```text
ipmsg_start(identity, group?) -> status
ipmsg_stop() -> ()
ipmsg_status() -> { enabled, port, error? }
ipmsg_peers() -> [{ id, user, host, nickname, group, ip, port, dialect, lastSeen }]
ipmsg_send_message(peerId, text) -> { packetNo, acknowledged }
ipmsg_offer_file(peerId, path) -> { packetNo, fileId, name, size }
ipmsg_download_file(offerId) -> { localPath, name, size }

rocketx://ipmsg-peer
rocketx://ipmsg-message
rocketx://ipmsg-file-offer
rocketx://ipmsg-file-ready
```

- 信心：中
- 会推翻它的证据：真实客户端要求先发送未列出的协商命令才能显示或拉取普通文件。

### 1.5 编码与方言

**决定**：标准 peer 优先 UTF-8；未声明能力时按 CP932。识别到飞秋私有前缀时按 GBK 解码，
并在回包中保留相同方言。为此允许增加一个小型、纯 Rust、无网络能力的字符集依赖；不复制
参考客户端实现。

- 信心：中
- 会推翻它的证据：真实 IP Messenger 5.8.3 或新的飞秋抓包展示不同编码协商。

## 2. 假设

| 假设 | 信心 | 来源 |
| --- | --- | --- |
| 普通明文通信仍被 IP Messenger 5.x 接受 | 高 | 官方帮助列出 basic message communication；真实验收会复核 |
| TCP 文件请求使用发送 UDP peer 的同一端口 | 高 | 官方 protocol.txt |
| 飞秋私有前缀后仍保留标准 packet/user/host/command/extra | 中 | 公开抓包 fixture，未执行真实二进制 |
| 一个聚合虚拟频道符合蓝图，而不是每个旧 peer 建本地 DM | 高 | 蓝图明确写「一个虚拟频道（局域网）」 |
| M10 不做群聊、目录、加密、网关模式 | 高 | 蓝图范围与冻结区 |

## 3. 偏离策略

- 协议边角问题默认选最保守方案：拒绝畸形报文、不自动下载、不自动打开、不把 IPMSG peer
  升格为 M9 可信 peer；把决定实时记到 `docs/implementation-notes.md` 的 M10 段落后继续。
- 端口 2425 被占用时明确报错并保持关闭；不能静默改端口，因为那会让“已上线”成为假状态。
- 真实客户端若要求加密或私有命令才能完成基础消息/文件，停止扩大安全面，重新执行 kickoff。
- 不执行无签名且多引擎告警的飞秋二进制；只有隔离环境和样本可信度变化时才重开该验收。

## 4. 机械工作（低审阅价值）

1. 新增 `ipmsg.rs` 的 codec、peer 表、UDP/TCP 生命周期、回执/去重、文件 offer 与下载。
2. 在 Tauri 注册 commands/state/events，退出和注销时停止服务。
3. 新增 Web runtime/store，把本地频道、peer、消息和附件持久化到账号隔离的 appData。
4. 给会话列表、ChatArea 和 Today 增加本地 IPMSG 分支，并使用独立的本地消息渲染器。
5. 新增设置开关、端口/peer/方言诊断，版本提升为 v0.19.0，更新架构与变更日志。

## 5. 验证

1. Codec fixture：官方六段报文、UTF-8、CP932、飞秋前缀/GBK、NUL 附件区、路径穿越、超长包。
2. Native loopback：发现、中文消息、ACK、重试去重、BR_EXIT、文件 offset 拉取、取消/过期 offer。
3. Web 回归：虚拟频道不调用 RC history/send/read；peer 选择；未处理消息进入 Today；账号隔离。
4. 真实客户端：签名版 IP Messenger 5.8.3 ↔ 实际 RocketX 双向消息和文件；记录版本、hash、步骤和结果。
5. 全门禁：typecheck、pure、regression、真实 RC smoke、Rust、Web production、Windows Tauri release、CI。

## 实施记录约定

沿用仓库现有 [`implementation-notes.md`](implementation-notes.md)，新增 M10 段落并在发现当下记录
Decisions / Deviations / Surprises / Questions for review。第三次偏离或任何前提被真实客户端推翻时，
停止补丁式修正并重新执行 kickoff。
