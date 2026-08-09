# `MEM` Codex 原生 Memory

> 当前状态：`受限可用`
> 基线：工作树 `2026-08-09`
> 平台：仅桌面端 + 支持 Memory 的兼容 Codex

## 1. 目标

让管家在后续任务中轻量召回用户偏好、习惯和有帮助的历史背景，并由 Codex 原生 Memory 持续维护。Memory 是辅助上下文，不是权限数据库、业务真源或必须执行规则的唯一载体。

## 2. 范围

### 包含

- 管家创建或恢复 Thread 时请求启用 Codex Memory 能力；
- 由 Codex 在后台提取、保存和召回本地记忆；
- Memory 启用失败时阻止任务开始并暴露真实错误。

### 不包含

- RocketX 自建“用户画像”数据库或旧版 Butler Memory Store；
- 在 RocketX 当前 UI 中浏览、编辑、删除或重置单条 Memory；
- 把 AGENTS、权限、审批规则、工作项状态或团队政策只存进 Memory；
- 与 ChatGPT 网页 Memory 自动同步。

## 3. 入口与前置条件

- Memory 没有独立主导航；它是管家 Thread 的运行能力。
- 当前 Codex 版本必须支持 `features.memories` 与 `thread/memoryMode/set`。
- Codex 本机全局 Memory 配置也必须允许该能力；上游默认配置可能关闭 Memory。

## 4. 主流程

1. RocketX 建立业务 MCP/Thread 配置时声明 `memories: true`。
2. 在首个 Turn 前，RocketX调用原生 Thread Memory 模式并等待成功。
3. Codex 在任务中按自身策略轻量装载相关 Memory，并在后台维护有价值的偏好与历史。
4. 后续 Thread 可由 Codex 召回这些 Memory；RocketX 不拼接一份自建画像到每个提示词。
5. 如果原生 Memory 启用失败，RocketX 不静默降级为“无记忆但看似成功”，而是阻止任务并要求修复 Runtime/配置。

## 5. 状态与交互

- `隐式启用`：当前 UI 不展示独立开关，任务启动前完成握手。
- `可用`：任务正常进入 Turn。
- `启用失败`：任务不开始，显示上游错误。
- `不可审阅`：当前 RocketX 没有 Memory 管理页面，不能声称用户已能查看画像。

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| 桌面端 + 支持 Memory 的 Codex | 受限可用 | 每个管家 Thread 显式请求启用 |
| Codex 全局 Memory 关闭/方法不支持 | 不可用 | 阻止任务启动并显示错误 |
| 无 Codex | 不可用 | 没有替代 Memory 实现 |
| 网页版 | 不可用 | 当前没有 Codex 执行面 |

## 7. 数据与同步

- Memory 由本机 Codex 管理，通常存放在用户的 Codex Home（如 `~/.codex/memories`）。
- RocketX 不复制、同步或上传 Memory 到 Rocket.Chat。
- Codex 本地 Memory 与 ChatGPT 网页 Memory 是分离系统。
- 更换操作系统账号、Codex Home 或清理 Codex 数据会改变可召回范围。

## 8. 权限与安全

- Memory 可能包含个人偏好和历史背景，必须视为本机敏感数据。
- 密码、Token、PAT、审批决定和必须执行的安全规则不应写为 Memory 事实。
- 必须执行的团队约束放入版本控制的 `AGENTS.md`、Skill 或政策配置。
- 用户无法审阅 Memory 时，不应对外承诺“完整、准确的用户画像”。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| `thread/memoryMode/set` 失败 | 任务启动失败并显示原因 | 不提交首个 Turn；升级/配置 Codex 后重试 |
| Memory 中的信息过时 | Codex 可能给出不合时宜的偏好 | 以当前用户指令和业务真源覆盖，不自动改结构化数据 |
| Memory 文件不可用 | 任务不能按当前强制启用契约开始 | 修复 Codex Home 权限或配置 |
| 用户要求查看/删除记忆 | 当前无 RocketX 管理面 | 明确引导到 Codex 原生管理方式，不假装已处理 |

## 10. 验收标准

- `MEM-AC-01`：创建和恢复 Thread 均在首个 Turn 前请求原生 Memory 模式。
- `MEM-AC-02`：Memory 启用失败时首个 Turn 不发送，页面显示真实错误。
- `MEM-AC-03`：代码中不存在并行维护的 RocketX 用户画像真源。
- `MEM-AC-04`：规格和 UI 不把 ChatGPT Memory 与本地 Codex Memory混为一谈。
- `MEM-AC-05`：强制规则与业务事实不依赖 Memory 才能正确执行。

## 11. 实现与测试证据

- 实现：`apps/web/src/agent/AppServerController.ts`、`apps/web/src/agent/businessMcp.ts`
- 自动化：`scripts/regressions/app-server-controller.test.ts`
- 上游参考：[Codex memories](https://learn.chatgpt.com/docs/customization/memories)

## 12. 已知差距与目标

- RocketX 尚无查看、修正、删除、重置和暂停 Memory 的用户界面。
- 需要增加一条真实跨 Thread 验证：写入稳定偏好、结束任务、在新 Thread 中确认相关召回，同时验证无关任务不会过度装载。
