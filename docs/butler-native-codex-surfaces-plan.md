# 管家采用 Codex 交互并支持双向切换 — 实施计划

> 文档状态：**历史实施计划**。当前同线程接续、显式刷新与降级边界见[管家任务](specs/butler-tasks.md)和[Codex Runtime](specs/codex-runtime.md)。

## 1. 最可能被调整的决策

### 决策 A：RocketX 内嵌 Codex 式工作面

```text
RocketX 全局导航
└─ 管家
   ├─ 任务：任务历史 + 当前任务
   ├─ 已安排：任务、状态、最近运行、立即运行
   └─ 插件：已启用 Skill 与能力来源
```

- 不再建立“动态、今日纸、管家身份、管家设置”等平行概念。
- Confidence: high。
- What would flip it: 用户明确要求某个额外工作面承担不可替代的确定性功能。

### 决策 B：切换到 Codex 是任务交接，不是主导航外跳

- 当前 RocketX 任务已经有 Codex thread id 时，打开 `codex://threads/{threadId}`，在 Codex App 接续同一线程。
- 尚未建立线程时，才用 `codex://threads/new` 预填完整上下文作为降级。
- 已安排和插件页面可提供次要的“在 Codex App 管理”入口，但主入口始终留在 RocketX。
- Confidence: high。
- What would flip it: 桌面版无法打开由 RocketX App Server 创建的持久线程；届时保留明确标注的“复制到新任务”降级。

### 决策 C：已安排复用现有可靠调度能力

- 已保存的 RocketX routines 继续作为内嵌已安排页的数据与执行层。
- 页面按 Codex Scheduled 的任务列表、启停、最近运行和立即运行语义收敛，不再展示内部版本等工程概念。
- Confidence: medium。
- What would flip it: Codex App Server 提供稳定 Scheduled CRUD 后，可切换为同一数据源。

### 决策 D：插件页只使用稳定接口

- 使用稳定的 `skills/list` 展示当前可用 Skill，并说明其插件来源。
- 不在生产路径调用官方仍标注 under development 的 `plugin/list/install/uninstall`。
- 安装、市场和复杂插件管理通过显式“在 Codex App 管理”切换完成。
- Confidence: high。
- What would flip it: Plugin App Server API 转为稳定生产接口。

## 2. Assumptions

- UI 留在 RocketX，Codex 提供任务模型和运行能力。来源：用户明确澄清；confidence high。
- RocketX 与 Codex App 可以在同一个持久线程上接续；切出后 RocketX 释放客户端，回切后显式 `thread/resume`。来源：App Server `thread/resume` 与既有 `codex://threads/{id}`；confidence medium，仍需随 Codex App 升级持续做真机兼容验证。
- Memory 继续使用 Codex 原生 Memory，不建立第二套设置页。来源：用户要求与当前实现；confidence high。
- App Server 适合嵌入任务历史、审批和流式事件。来源：OpenAI Docs；confidence high。

## 3. Deviation policy

- 兼容边界选择可逆方案：保留旧 routine 数据，不做迁移或删除。
- 当前线程切换失败时，明确提示并降级为“复制到 Codex 新任务”，不伪装成同一线程。
- 不为了界面完整调用官方明确禁止生产使用的插件协议。
- 必须停止的情况：需要删除旧数据、扩大 URL 安全白名单、或发现两端无法共享任何持久线程。

## 4. Mechanical work（低评审价值）

- 撤回“主导航直接打开 Codex 页面”的实现，仅保留 thread deep link。
- 重建精简的任务、已安排、插件三个内嵌工作面。
- 给任务和管理页增加明确的 Codex App 切换入口。
- 更新自然语言指令：打开内嵌页和切换 Codex 是两种不同动作。
- 更新回归与 UI 测试。

## 5. Verification

- 管家默认展示任务历史和当前任务。
- “已安排”“插件”在 RocketX 内打开，不触发外部应用。
- “切换到 Codex”优先打开当前 thread id，并释放本地客户端；回到 RocketX 后 resume 同一 thread。无 thread id 时使用完整上下文降级。
- 已安排可真实启停、立即运行并查看最近结果。
- 插件页通过 `skills/list` 获取真实能力，不调用 `plugin/list`。
- 宽屏与 390px 无横向溢出，视觉门禁 >= 90。
- TypeScript、Rust、安全白名单、逻辑回归和 UI 交互测试通过。

## Handoff

- 实施中持续更新 `docs/implementation-notes-butler-native-codex-surfaces.md`。
- 第三个 deviation 或前提被推翻时重新执行 kickoff。
