# 提案：项目管理扩展系列——个人看板与团队规划（issue #82、#83）

> 状态：**方向已调整并落地一期**，2026-07-18。
>
> 采纳 issue 作者的想法：**直接用 ADO 上已维护的查询做数据源**，在工作台的
> 自定义查询结果上提供「列表 / 看板 / WBS」三种视图（`lib/queryViews.ts` +
> `components/QueryViews.tsx`）。查询定义「看什么」（范围、过滤在 ADO 端维护、
> 权限由 ADO 管），视图只负责「怎么看」——个人看板 = 一个 @Me 查询切到看板视图，
> 团队 WBS = 一个 tree 查询切到 WBS 视图。不需要新建扩展应用，也不需要
> `ado.query` 能力总线。
>
> 以下原方案保留作为二期参考：若未来要把看板/规划开放给第三方应用生态，
> 能力总线（§2）仍是正确的底座；`ado:write`（拖拽改状态）也依赖它。

## 1. 背景与定位

- issue #82：希望有 Azure DevOps boards 那样的 kanban，方便看**自己的工作**。
- issue #83：希望有 WBS、整体项目进度与风险视图，管**团队的工作**；issue 本身建议做成扩展应用。

两者共享同一层数据（ADO 工作项），但视角不同（个人执行 vs 团队规划），拆成两个独立扩展应用，
都跑在 M11 应用生态上（`@rcx/app-sdk`，iframe runtime，最小权限），不进主应用：

- 主应用的双支柱是 GTD + 注意力保护（blueprint §1），个人队列已有工作台仪表盘；
  团队规划是另一类工具，塞进主导航会稀释定位。
- 现有 `examples/kanban-app` 已验证 `nav.module` 贡献点跑通 iframe 应用，路径可行。

## 2. 前置：宿主暴露 `ado.query` 能力

两个应用都需要读 ADO，但**扩展不应各自持有 PAT**。参照 M9 的 `lan.peers`/`lan.send` 前例，
在应用能力总线上新增：

| 能力 | 权限 | 说明 |
| --- | --- | --- |
| `ado.query` | `ado:read`（新增 APP_PERMISSIONS 项） | 用宿主已配置的连接执行 WIQL / 取工作项批量详情，返回结构化结果 |
| `ado.update`（二期） | `ado:write`（新增） | 仅支持字段级更新（State/AssignedTo/IterationPath），宿主弹确认 |

- 凭据、限流、缓存都留在宿主（复用 `lib/adoDirect.ts` 与 bridge 两条路径）。
- `ado:write` 的每次调用默认走宿主确认弹层（同 Codex 审批的交互习惯），应用不能静默改数据。
- AI 助手现有的「模型只读、写入走草案确认」原则原样适用。

## 3. 应用一：`rocketx-boards` 个人看板（issue #82）

**一句话**：把「指派给我的工作项」按状态列成拖拽看板，像 ADO boards 的 assigned-to-me 视图。

- manifest：`permissions: ["ado:read", "storage:local", "ui:notify"]`（二期加 `ado:write`），
  `contributes.nav.module: [{ id: "boards", label: "看板" }]`。
- 列 = 工作项状态。从过程配置读真实状态名（复用 `directGetWorkItemHierarchy` 同款
  processconfiguration API），不硬编码 New/Active/Closed。
- 卡片 = 工作项：编号、标题、类型、迭代、父项链；点击用现有 `WorkItemLink` 深链打开。
- 过滤：默认 `@Me`，可切项目 / 迭代 / 类型；过滤条件存 `storage:local`。
- **一期只读**（拖拽禁用）；**二期**开 `ado:write` 后支持拖列改 State，宿主确认后生效。

## 4. 应用二：`rocketx-planning` 团队规划（issue #83）

**一句话**：Feature → Story → Task 的 WBS 树 + 按树汇总的进度与风险信号。

- manifest 同上（`ado:read` 起步），`nav.module: [{ id: "planning", label: "规划" }]`。
- **WBS 树**：按 `System.Parent` 组树（主应用 `lib/workItemTree.ts` 的组树逻辑抽到共享纯函数，
  或复制到应用内——避免应用依赖宿主私有模块）。
- **进度**：每个节点显示子树完成度（closed/total 的比例 + Story Points 加权可选）、迭代分布。
- **风险信号**（一期规则化，不引入 AI）：
  - 逾期：目标日期已过且未关闭；
  - 停滞：N 天无 ChangedDate 更新（默认 7 天，可配）；
  - 未指派：非关闭状态且 AssignedTo 为空；
  - 迭代超载：某人当前迭代 active 工作项超过阈值。
- **二期**：风险摘要接 AI 管家（`ai:invoke`），生成周报草稿贴回指定讨论组（复用「草案 → 用户确认发送」模式）。
- 甘特图、依赖线、资源日历：**不做**（明确非目标，避免滑向完整 PM 套件）。

## 5. 交付形态

1. 两个应用放 `examples/`（与现有官方样板同级）起步，走 `create-rcx-app` 校验与 clean-room 门禁；
   稳定后再决定是否提升为独立仓库 + 应用源分发。
2. 现有 `examples/kanban-app`（消息看板 demo）保留作 SDK 教学样例，`rocketx-boards` 是独立新应用，
   避免语义混淆可考虑把 demo 改名为 `message-board-app`。

## 6. 里程碑建议

1. **P1（能力层）**：`ado:read` 权限 + `ado.query` 能力总线 + 回归测试（含权限拒绝路径）。
2. **P2（#82 一期）**：`rocketx-boards` 只读看板。
3. **P3（#83 一期）**：`rocketx-planning` WBS 树 + 进度 + 规则化风险。
4. **P4（二期）**：`ado:write` + 拖拽改状态；AI 周报草稿。
