# Implementation Notes: 管家 Markdown 与团队配置来源

**Plan:** `.omx/plans/markdown-config-sources.md`

## Status

已完成。

## Unknowns & discoveries

- Markdown 解析器已覆盖主要块语义；完成态回复统一使用 Codex 风格容器。流式文本继续按纯文本增量显示，避免每个 token 重排，完成后再渲染完整 Markdown。
- ADO 仓库文件读取与认证链路已存在，只缺从用户粘贴链接提取结构化位置。
- 普通文件导入刻意不保存绝对路径；UNC 跟随来源使用独立持久化契约和受限桌面读取命令。

## Deviations

- 不把 ADO 链接当普通匿名 URL 请求，避免绕过现有认证并触发登录页/权限错误。
- 不开放任意本机文件路径读取；UNC 仅接受普通 `\\server\share\...json`，拒绝设备路径、盘符、点段和混合分隔符，并限制读取为 1 MiB。

## Verification log

- Markdown、配置来源与滚动相关回归：43/43 通过。
- Web typecheck 与 Vite production build 通过。
- Playwright 桌面/移动视觉门禁通过；视觉复核 93/100，移动端代码块无裁切。
- Rust `cargo fmt --check` 与 UNC 定向测试通过；Debug 构建通过。
- 安全二次复核：0 HIGH、0 MEDIUM。真实企业 UNC 权限环境仍需使用实际共享路径做一次人工冒烟。
- Debug 可执行文件已启动：`apps/desktop/src-tauri/target/debug/rocketx.exe`。

## Change log

- 建立实现边界与验收计划。
- 管家完成态 Markdown 补齐标题、段落、列表、引用、表格、代码块与移动端布局。
- 团队配置统一入口支持普通 URL、ADO 文件链接和 UNC 共享 JSON；ADO 复用当前工作台认证。
- UNC 原生读取增加严格路径校验、有界读取和阻塞任务隔离。
