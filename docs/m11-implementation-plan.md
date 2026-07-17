# M11 开源发布与应用生态 v0 实施计划

蓝图：[`blueprint.md`](blueprint.md) §6
目标版本：v0.20.0（2026-07-17 用户决策：继续 0.x；未来 1.0 单独完成成熟度验收）

## 1. 最可能调整的决定

### 1.1 manifest 契约归属 `@rcx/app-sdk`

公开面：

```ts
export const APP_PERMISSIONS: readonly AppPermission[];
export const EXTENSION_POINTS: readonly ExtensionPoint[];
export function parseManifest(value: unknown): RcxAppManifest;
export function parseManifestJson(json: string): RcxAppManifest;
export function createBridgeClient(options?: BridgeClientOptions): BridgeClient;
```

Web 内核和 CLI 都从 SDK 导入这些定义；不再保留第二份 manifest 白名单或解析器。

- **Confidence: high**
- **What would flip it**：SDK 必须在 Web 内核之外支持不同 manifest 方言；当前蓝图和代码都没有此需求。

### 1.2 一个 CLI 包暴露两个命令

包名 `create-rcx-app`，同时暴露：

```text
create-rcx-app <directory> [--template hello|kanban|poll|oncall]
rcx-app validate [directory]
rcx-app dev [directory] [--port 4174]
```

`validate` 复用 SDK 契约并检查 entry 文件；`dev` 提供本地静态预览与文件变化自动刷新，
不放宽 RocketX iframe 的 `connect-src 'none'`，真实能力仍通过目录安装验收。

- **Confidence: medium**
- **What would flip it**：蓝图要求热重载必须发生在 RocketX 沙箱内部；那需要新增 localhost
  开发信任边界，必须单独做安全设计，不能混入 v0 CLI。

### 1.3 样板应用只使用现有能力

| 样板 | 能力 | 权限 |
|---|---|---|
| 看板 | 当前会话消息转卡片、本地持久化 | `chat:read`, `storage:local`, `ui:notify` |
| 投票 | 在当前已加入会话发布投票文本、本地统计 | `chat:read`, `chat:write`, `storage:local`, `ui:notify` |
| 值班表 | 本地轮班表、房间成员读取、发布当班通知 | `chat:read`, `chat:write`, `users:read`, `storage:local`, `ui:notify` |

任何样板专用 capability、私有 API 或额外宿主开关都视为失败。

- **Confidence: high**
- **What would flip it**：现有 capability 无法完成样板的最小闭环；先缩小样板交互，不先扩内核。

### 1.4 双语入口与自部署

- 根 `README.md` 改为英文主入口，现有中文内容保存在 `README.zh-CN.md`，两者互链。
- `docker/docker-compose.yml` 默认同时启动固定版本 Rocket.Chat、MongoDB 和 RocketX Web 静态服务；
  RocketX 镜像从当前源码构建，不发布 `latest` 依赖。
- 兼容矩阵单独放在 `docs/compatibility.md`，README 只保留摘要。

- **Confidence: medium**
- **What would flip it**：现有主要用户要求中文根入口；此时保留中文根 README，新增 `README.en.md`，
  不改变其余交付。

### 1.5 发布动作分层

1. PR/CI 验证 SDK tarball、CLI clean-room、三样板、协议生成树、Web/Rust 和桌面构建配置。
2. 合并 `main` 后创建 `v0.20.0` 标签，复用现有三平台工作流生成草稿 Release。
3. 三平台产物存在且校验后才发布 GitHub Release；npm 发布仅在本机/CI 具有对应 scope 权限时执行。

`@rcx/app-sdk` 与 `create-rcx-app` 在 npm registry 当前均为 404，但 404 不证明当前账号拥有
`@rcx` scope。

- **Confidence: high**
- **What would flip it**：npm scope 无权或三平台签名材料缺失；GitHub v0.20.0 不因此伪装 npm 已发布，
  Release notes 明确包的安装替代路径。

## 2. Assumptions

- M6–M10 已合并 `main`；高置信，来自 Git 历史和 v0.19.0 验收记录。
- `@rcx/app-sdk` 与 `create-rcx-app` 名称当前未公开发布；中置信，来自 2026-07-17 npm registry 404，
  可能受私有包可见性影响。
- 三平台 workflow 可创建安装包和草稿 Release；高置信，来自 `.github/workflows/desktop.yml`。
- Windows/macOS 未配置的签名材料不阻止生成可测试的未签名产物；中置信，最终以 workflow 为准。
- G3/G4 自动 clean-room 是发布前代理门禁，不等同蓝图要求的两位真人计时；高置信，真人证据必须
  单独记录。
- 不新增产品运行时依赖；高置信，来自仓库工作约定。CLI 优先使用 Node 标准库与现有 TypeScript。

## 3. Deviation policy

边角问题默认选保守方案：可逆、最小影响、最接近现有安全契约，并实时记录到
`docs/implementation-notes.md` 的 M11 小节后继续。

- CLI 能力不足时先缩小模板/预览体验，不放宽 iframe CSP 或引入远程代码执行。
- 发布凭据不足时保留可本地 `npm pack` 安装的 tarball，不声称已公开发布。
- 桌面签名不足时发布说明标明未签名，不绕过平台安全机制。
- Docker/Web 遇到跨域限制时修正可复现开发配置，不给生产默认 `*` 以外再扩大权限。

以下情况必须停止并重新确认：覆盖已有公开 npm 包、重写标签/Release、扩大第三方应用权限或网络面、
引入新的外部依赖、真人 G3/G4 证据与自动代理结果冲突。

第三条 Deviation 或任一 Surprise 推翻前提时，停止补丁并重新执行 kickoff。

## 4. 机械工作（低审阅价值，信任实现者）

1. 让 SDK 产出 ESM JavaScript、`.d.ts` 和可审计 tarball，统一 manifest/extension 类型。
2. 新增 CLI 包、模板生成、校验、开发服务器和 clean-room 回归。
3. 升级看板，新增投票和值班表，并让 CI 对全部 manifest/entry 做契约校验。
4. 新增 RocketX Web Dockerfile/静态服务，把固定版本服务加入 compose 与健康检查。
5. 补齐英文 README、中文副本、CONTRIBUTING、SECURITY、第三方许可、兼容矩阵和应用开发教程。
6. 重新生成 pinned Codex 协议树，将 `codex:protocol:check` 纳入 CI。
7. 统一 v0.20.0 版本、CHANGELOG、Tauri/updater/Agent 协议口径，增强三平台 Release workflow。
8. 记录 clean-room G3/G4 代理耗时、三平台产物、哈希和仍需真人完成的证据。

## 5. Verification

- `npm pack --dry-run` / 解包：SDK 只公开 `dist`、README、LICENSE，JS 和类型可由临时项目导入。
- clean-room G4：空临时目录运行脚手架，生成应用，`validate` 通过，`dev` 修改文件后触发刷新信号；
  全流程计时并保存日志。
- 三样板：manifest 通过同一 SDK parser；entry 存在；静态脚本不调用未声明 capability；目录安装回归通过。
- clean-room G3：全新 compose project 构建并启动 RC + RocketX，健康检查通过，登录页可访问；计时并清理。
- 安全：远程高危权限、路径穿越、缺 entry、未知权限、CSP 放宽尝试全部被拒绝。
- 全门禁：typecheck、pure、regression、真实 RC smoke/classify、Codex 本机运行时、Codex protocol、Rust、Web
  production、Windows release；PR CI 通过。
- 发布：`v0.20.0` 三平台 workflow 成功，Release 至少含 Windows/macOS/Linux 产物与 SHA-256 清单；
  npm 包仅在 registry 查询确认公开可见后标记完成。
- 未来 1.0 真人验收：两位外部开发者分别执行 G3/G4，均在 30 分钟内完成；证据未取得前不得把 1.0 成熟度门禁写成通过，但不阻塞 v0.20.0。

## Handoff

实施沿用 `docs/implementation-notes.md`，新增 M11 的 `Decisions`、`Deviations`、`Surprises`、
`Questions for review` 四段；所有偏离即时记录文件/行号。实现完成后在该段顶部用三句话对照本计划总结，
再执行收工审阅与发布门禁。
