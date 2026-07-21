# 飞鸽 / IPMSG RocketX 插件

该目录拥有完整的旧协议功能：`index.html` 是沙箱界面，`native/` 是独立 Rust Sidecar。RocketX 核心只提供通用的签名 Sidecar 生命周期、JSON-RPC 转发、应用存储和文件选择能力，不包含协议、端口或编码逻辑。

## 兼容边界

- 标准 IP Messenger：UDP 2425 发现/消息，TCP 2425 普通文件传输。
- 飞鸽/飞秋兼容报文：识别 `1_lbt` 前缀并使用 GBK。
- 原版内网通：识别 `1@shiyeline` 的 2425 报文并使用 GBK，只承诺发现和文本。
- 不监听或模拟私有 9011 协议；内网通联系人不会显示文件发送入口。
- 所有旧协议联系人均为未认证 peer，不继承 RocketX 可信 LAN 身份。

发现范围支持单个 IPv4、CIDR 和起止范围，合计最多展开 1024 个目标。附件不会自动下载或打开，接收文件必须由用户点击确认。

## 运行方式

插件随 RocketX 签名桌面包交付，默认关闭。启用时宿主从只读资源目录启动 `rcx-plugin-intranet-link`，禁用或退出时关闭 Sidecar 并释放 2425。当前 Sidecar 只随 Windows 包构建，普通目录安装和 URL 安装均不能获得 `native:service` 权限。

本地验证：

```powershell
cargo test --manifest-path plugins/intranet-link/native/Cargo.toml --locked
pnpm prepare:sidecars
pnpm test:regression
```
