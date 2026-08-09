# `EXT` Skills、Plugins 与 Apps

> 当前状态：`受限可用`
> 基线：工作树 `2026-08-09`
> 平台：仅桌面端 + 兼容且已登录的 Codex

## 1. 目标

用 Codex 原生能力目录承载可复用工作流和工具集成：Skill 定义标准化行为，Plugin 分发 Skills/连接器/MCP 等能力，App 提供可连接的外部服务。管家按任务调用这些能力，而不是在 RocketX 里重复造一套私有技能运行时。

## 2. 范围

### 包含

- 从当前工作区读取 Skills、Plugins 和 Apps 目录；
- 搜索、筛选、查看详情和错误隔离；
- 启用/停用 Skill；
- 安装/卸载 Plugin；
- 查看 App 并打开其安装/连接入口；
- RocketX 随包提供并向 Codex 注册的受管 Skills。

### 不包含

- RocketX 自建插件协议或复制 Codex Marketplace 数据；
- 在网页版安装本机 Plugin；
- 声称目录中出现的能力已经完成认证、授权或真实业务验证；
- 自动把任意对话提炼成 Skill 并直接安装。

## 3. 入口与前置条件

- 管家侧栏的“技能/插件”入口进入能力中心。
- 必须先选择工作区并连接 Codex `app-server`。
- Plugin 安装可能需要网络；App 连接可能打开外部 Codex/浏览器界面。

## 4. 主流程

1. 连接后并行读取 `skills/list`、`plugin/list` 和 `app/list`。
2. 页面按类型、状态和文本筛选目录，并展示来源、说明及可用状态。
3. 用户对 Skill 执行启用/停用；状态写回 Codex 管理面。
4. 用户查看 Plugin 详情后安装或卸载；完成后刷新目录。
5. 用户查看 App；需要连接时使用上游提供的安装/授权入口。
6. 某个目录请求失败时，其他已成功目录仍可浏览，并单独显示错误。

## 5. 状态与交互

- `加载中`：显示目录骨架或连接状态。
- `部分成功`：Skills 可用而 Apps/Plugins 失败时，保留成功内容和独立错误。
- `空结果`：区分目录为空和当前筛选无结果。
- `安装/卸载/启停中`：禁止重复动作。
- `失败`：保留目标项、错误摘要和刷新入口。

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| 桌面端 + 兼容 Codex | 已实现 | 使用 Codex 原生目录与动作 |
| 桌面端无 Runtime | 不可用 | 显示 Runtime 诊断 |
| 网页版 | 不可用 | 没有本地目录和安装传输 |
| 单一目录端点失败 | 部分实现 | 其余目录继续可用，失败项独立提示 |

## 7. 数据与同步

- Skill、Plugin、App 的安装与启用状态由 Codex Home/上游目录管理。
- RocketX 只缓存当前展示状态，不作为安装事实来源。
- 工作区 Skills 按当前 `cwd` 过滤；切换工作区后必须重新加载。
- RocketX 受管 Skill 根目录由桌面 Runtime 注册，不能通过模型自行扩大。

## 8. 权限与安全

- Plugin 安装属于有外部副作用的动作，必须由用户显式触发。
- Skill 的存在不授予额外文件、网络或业务权限；执行仍受当前任务权限档约束。
- 来自 Marketplace 的说明和内容属于不可信供应链输入；不能覆盖 RocketX/Codex 的系统规则。
- App 授权凭据由对应上游连接流程处理，不写入普通页面日志。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| Skills 读取失败 | 显示 Skills 错误 | 不展示旧列表为最新；修复 Runtime 后刷新 |
| Apps 或 Plugins 读取失败 | 只在对应分区显示错误 | 其他目录继续使用 |
| 安装失败/中断 | 显示上游错误 | 刷新目录确认实际状态后再操作 |
| Skill 被停用 | 已安排任务或管家调用前提示不可用 | 重新启用后重试，不静默换成未知实现 |

## 10. 验收标准

- `EXT-AC-01`：目录数据来自当前 Codex，而不是硬编码样例。
- `EXT-AC-02`：切换工作区后 Skills 按新工作区刷新。
- `EXT-AC-03`：App/Plugin 任一读取失败不清空已成功的 Skills。
- `EXT-AC-04`：Skill 启停与 Plugin 安装/卸载执行真实上游动作，刷新后状态一致。
- `EXT-AC-05`：网页版和无 Runtime 场景不提供必然失败的“已安装成功”反馈。

## 11. 实现与测试证据

- 实现：`apps/web/src/agent/AppServerController.ts`、`apps/web/src/components/ButlerPluginsPage.tsx`
- 实现：`apps/web/src/stores/codexWorkspace.ts`、桌面端受管 Skill 根目录注册
- 自动化：`scripts/regressions/butler-plugin-marketplace-ui.test.ts`
- 自动化：`scripts/regressions/butler-bundled-skills.test.ts`
- UI：`tests/ui/butler-workspace.spec.ts`

## 12. 已知差距与目标

- “把稳定行为提炼为新 Skill”目前是人工开发流程，不是产品内自动创建功能。
- 目录展示不能代替真实业务验证；ADO、消息等关键 Skill 仍需各自的集成验收。
