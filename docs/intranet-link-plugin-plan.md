# 内网通独立应用与 LAN P2P 优化计划

## 当前实现

内网通以独立 RocketX 应用 + 宿主兼容通道共同交付：

1. 宿主在桌面端开启「内网通兼容模式」后同时监听 UDP/TCP `2425` 与内网通常见 `9011` 端口。
2. `2425` 继续作为飞鸽/IP Messenger/飞秋兼容端口；`9011` peer 标记为 `intranet` dialect，使用 GBK 旧编码并复用相同的消息与文件帧。
3. 收到的旧协议 peer 仍是未认证 legacy peer，不复用 M9 可信 LAN 的 Ed25519 固定公钥、可信设备或 Rocket.Chat 会话身份。
4. 宿主继续负责旧协议 socket、确认包、TCP 文件拉取/提供与本地文件路径；应用只通过 Bridge 访问去敏 capability。

## 独立应用边界

`plugins/intranet-link` 是第一版独立插件包：

- `rcx.app.json` 声明 `lan:discover`、`lan:transfer`、`ui:notify`。
- 导航模块名为「内网通」，同时提供 `/intranet` composer command。
- `index.html` 是插件包内的单文件 iframe 应用，只通过 `window.__RCX_BRIDGE__` 调用宿主能力。
- 左侧调用 `ipmsg.peers`，展示去敏后的 id、user、host、nickname、group、dialect、supportsUtf8、lastSeenMs。
- 右侧调用 `ipmsg.send` 发送聊天消息；调用 `ipmsg.offerFile` 发送普通文件邀请，实际传输由旧协议 TCP P2P 完成。

## Bridge capability

- `ipmsg.peers` → `lan:discover`：必要时启动兼容模式，刷新 peer，再返回去敏联系人列表。
- `ipmsg.send` → `lan:transfer`：选择 peer 并发送旧协议聊天消息。
- `ipmsg.offerFile` → `lan:transfer`：选择 peer 并发送普通文件 offer；本机路径只进入宿主，不暴露给远端应用脚本之外的能力面。

## 继续优化

1. 用真实内网通客户端抓包确认 9011 上是否还有私有扩展字段、加密握手或差异化文件属性。
2. 若发现私有扩展，新增 `Dialect::Intranet` 的专用解析/构造分支；当前实现先按 IPMSG/飞秋兼容帧处理。
3. 增加传输调度指标：同网段 P2P 吞吐、失败回退原因、BLAKE3/旧协议校验结果和续传次数。
4. 对 RocketX 可信 LAN 文件通道继续保留 M9 的 1 MiB 分片、最多四路 TCP、BLAKE3 分片/整文件校验与 `.part` 续传；旧协议文件互通仅承诺普通文件。

## 验收

- 开启兼容模式后，宿主能发现 2425 的飞鸽/IP Messenger/飞秋 peer，也能发现 9011 的内网通 peer。
- 选择内网通 peer 后，可以从独立应用或内置兼容频道发送聊天消息。
- 对方发送普通文件 offer 时，RocketX 展示文件卡片，用户点击后才下载。
- RocketX 发送普通文件时，对方通过旧协议 TCP P2P 拉取文件。
- `ipmsg.peers` 返回值不得包含本机私钥、挑战材料或 M9 可信设备字段；旧协议 peer 始终显示为未认证。
