# 飞鸽 / IPMSG 插件化方案

## 已确定边界

RocketX 核心仅保留通用 Native Sidecar Runtime：验证内置官方应用、从应用资源目录启动 `rcx-plugin-*`、限制 JSON-RPC 帧、转发事件，并在禁用、退出或进程异常时清理。核心不得出现 IPMSG 命令字、2425/9011 端口、GBK 或厂商方言。

`plugins/intranet-link` 拥有：

- UDP/TCP 2425 socket、发现范围、peer TTL、消息确认重试和普通文件传输；
- 标准 IPMSG UTF-8/CP932、飞鸽 `1_lbt` GBK、内网通 `1@shiyeline` GBK 解析；
- 联系人、消息记录、设置、文件确认和兼容性提示界面；
- 独立 Cargo 清单、锁文件、单元测试和 Windows Sidecar 构建产物。

## 安全策略

- `native:service` 只授予随 RocketX 签名发布的内置插件，目录/URL 应用一律拒绝。
- 命令必须使用 `rcx-plugin-*` basename，并从打包资源目录 canonicalize；不搜索 PATH，不接受越界路径。
- 单帧上限 1 MiB，调用超时 5 分钟；禁用时先关闭 stdin 让 Sidecar 广播退出，2 秒后仍未结束才强制终止。
- 本地文件路径只能由宿主文件选择器产生；附件不自动下载、不自动打开。

## 兼容承诺

- 原版 IP Messenger/标准飞鸽：发现、文本和普通文件。
- 原版内网通：仅 2425 发现和文本；不实现私有 9011，也不声称文件兼容。
- 首版 Sidecar 只打包进 Windows；macOS/Linux 保持插件可见但明确提示平台不支持。

## 验收

1. 核心 Web/Tauri 源码不含 IPMSG、飞鸽、`shiyeline`、2425、9011 或 GBK。
2. 插件启用后 Sidecar 绑定 UDP/TCP 2425；禁用后进程退出且端口释放。
3. 标准、`1_lbt` 和 `1@shiyeline` fixture 均能正确解码；畸形报文和路径穿越被拒绝。
4. 标准 IPMSG 双向消息、确认重试和普通文件字节流测试通过。
5. 原版内网通 peer 的文件入口保持禁用，界面不宣称 9011 或文件兼容。
