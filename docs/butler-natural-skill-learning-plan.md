# 管家自然交互与对话沉淀 Skill 改造计划

> 文档状态：**已废弃**。旧学习 Extension 和 RocketX 私有 Skill 保存链路不再使用；当前 Skill 发现、管理和执行以[Skills、Plugins 与 Apps](specs/skills-and-plugins.md)为准。

原记录状态：已获产品方向确认，可进入实现。
目标：把“管家刚刚替我完成的真实工作”自然地沉淀为可复用 Skill，同时保留并强化技能中心，减少用户需要理解的内部概念。

## 1. 最可能需要调整的决策

### 1.1 第一阶段只打通一条完整闭环

首个候选版本交付以下闭环：

```text
管家完成一次真实工作
  ├─ 用户明确说“把这套做法保存为 Skill”
  └─ 同类工作成功出现 3 次、跨至少 2 天
          ↓
对话中出现轻量建议
“这套做法已经比较稳定，要保存为 Skill「候选版本评审」吗？”
[查看草稿] [先不用]
          ↓
Skill 草稿
何时使用 / 做法步骤 / 会读取什么 / 会产生什么
需要确认 / 易错点 / 如何验证
          ↓
[保存到技能中心]
          ↓
默认仅当前用户可用，并由现有 Skill 运行链路按需匹配
```

- 置信度：高。
- 会推翻该决策的条件：产品要求第一阶段同时包含团队发布、版本审核和多人协作。
- 明确不做：自动保存、自动启用共享、每次任务结束都弹建议、另建第二套 Skill 商店。

### 1.2 技能中心保留，并成为 Skill 的唯一管理入口

- 将现有侧栏“记忆与技能”改为“技能中心”。
- 保留 `ButlerLearnedPanel` 已有的本地 Skill、Codex 原生 Skill、插件市场、导入、编辑、复制、启停和删除能力。
- 点击“技能中心”后直接落到现有 `memory` 页签，不再先展示“相处设定”。第一阶段不重写整套管家设置导航。
- 新生成的草稿和已保存 Skill 都回到这个入口查看，避免“分析与改进”和“技能中心”各维护一套创建流程。

- 置信度：高，来源是用户明确要求“技能中心不要删”。
- 会推翻该决策的条件：产品要求技能中心升为一级主导航；届时再单独拆分 `ButlerIdentityPage`，本阶段不提前扩张。

### 1.3 自动建议基于真实语义场景，不分析原始聊天文本

- 真实工作完成后，使用 `ButlerTaskState.manifest.scenario` 记录 `workflow:<scenario>`，不再把所有成功工作都记成 `ask:ad-hoc`。
- 仅在 `taskState.status === 'completed'` 时记为成功；失败、暂停、等待确认不计入候选。
- `general` 场景不进入自动挖掘，避免把普通问答误判成工作方法。
- 自动建议继续采用现有阈值：同类成功工作至少 3 次，且跨至少 2 天。
- 已存在同名或同场景 Skill、已忽略的建议，不重复打扰。
- 用户明确要求保存时不受重复次数限制，但仍先给草稿、再由用户确认写入。

- 置信度：高，现有任务模型已经提供语义场景，且这是最小修复。
- 会推翻该决策的条件：真实使用中大量有效流程只能落到 `general`；届时应先补场景识别，而不是偷偷扫描全部聊天内容。

### 1.4 Skill 草稿采用结构化合同，最终仍写成原生 `SKILL.md`

新增一个小而明确的数据结构，替代 `micro-skill` 当前仅有的通用 `preview: string[]`：

```ts
interface ButlerSkillDraft {
  id: string;
  proposalId?: string;
  name: string;
  title: string;
  description: string;
  whenToUse: string[];
  procedure: string[];
  pitfalls: string[];
  reads: string[];
  effect: 'read' | 'draft';
  confirmations: string[];
  verification: string[];
  source: {
    sessionId: string;
    lineIds: string[];
    scenario: ButlerScenario;
  };
  status: 'draft' | 'saved' | 'dismissed';
  createdAt: number;
}
```

- 草稿由已完成任务的 `manifest`、实际工具步骤和来源类型生成；不新增 LLM 服务或依赖。
- 对预定义场景给出可编辑的完整草稿；`general` 只支持用户明确发起，并标记需要补充内容。
- 保存时由纯函数生成标准 Markdown，再复用现有 `saveSkill({ name, description, body })`。
- Skill 正文固定包含“何时使用、做法步骤、易错点、需要确认、如何验证”，便于人审阅，也便于 Codex 按需加载。

- 置信度：中高。
- 会推翻该决策的条件：实现时发现已有原生 Skill 管理 API 能无损承载这些字段；届时改用原生合同，但 UI 与确认流程不变。

### 1.5 对话只说用户能理解的话

用户可见词汇保留：

- “保存为 Skill”
- “查看草稿”
- “保存到技能中心”
- “这次使用了「候选版本评审」Skill”（仅在确实使用时轻量披露）

用户不可见词汇：

- `OperationReceipt`
- `intentKey`
- `workflow:*`
- “micro Skill”
- “dry run”（改为“用过去几次结果试一下”）

本阶段不顺手改造“委托”“私人工作代理”等其他导航文案；这些属于下一批概念清理，避免扩大候选版本风险。

- 置信度：高。
- 会推翻该决策的条件：产品决定本轮同时完成全局信息架构重命名。

### 1.6 已验证的前提与参考取舍

当前仓库事实：

- 技能中心能力已经完整存在于 `apps/web/src/components/ButlerLearnedPanel.tsx`，无需重建。
- 重复行为分析和 `micro-skill` 安装逻辑已经存在于 `apps/web/src/butler/extensions/learning/`，但入口藏在“分析与改进”。
- 真实对话目前在 `apps/web/src/pages/ButlerPage.tsx` 中统一记录为 `ask:ad-hoc`。
- 现有端到端测试通过手工写入 `workflow:release-risk-check` 才能触发 Skill 建议，因此生产闭环尚未成立。
- `saveSkill` 已将 Skill 镜像到 Butler 私有工作区 `.agents/skills/<name>/SKILL.md`；桌面端根目录位于应用数据目录，不是团队仓库。

从 Hermes 借鉴的是交互语义，不复制代码或视觉：

- 保留：从刚完成的对话学习、先预览再写入、按需加载、标准的触发/步骤/陷阱/验证结构。
- 改造：命令式 `/learn` 变成自然语言“把这套做法保存为 Skill”，并接入 RocketX 现有技能中心。
- 放弃：终端式管理界面、要求普通用户记住命令、自动修改或删除 Skill、暴露内部意图键。
- 参考：[Hermes Skills 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)、[Hermes Skills 页面实现](https://github.com/NousResearch/hermes-agent/blob/main/web/src/pages/SkillsPage.tsx)。

## 2. 假设、置信度与来源

| 假设 | 置信度 | 来源 | 若不成立如何处理 |
| --- | --- | --- | --- |
| 本轮目标是实际产品改造，不是独立静态原型 | 高 | 用户已确认 UI 方向后说“开始改造” | 若只需原型，则只保留组件和假数据，不接存储 |
| Skill 默认私人保存 | 高 | 用户已确认；现有 Butler home 也是私有应用数据 | 团队共享另立发布/审核设计，不混入本轮 |
| 自动学习不保存原始聊天全文 | 高 | 现有学习设计的隐私边界 | 只保留语义回执和草稿来源 ID |
| 第一阶段不增加新依赖 | 高 | 仓库规则与最小改动原则 | 发现硬性能力缺口时先停下评审 |
| 已安装 Skill 仍由现有 Codex/RocketX 链路按需使用 | 中高 | `ButlerLearnedPanel`、`saveSkill` 与私有工作区现状 | 补一条真实运行验证；不另建执行引擎 |
| 预定义 `ButlerScenario` 足以覆盖首批高价值工作 | 中 | 当前已有候选版本、PR、承诺、构建等语义场景 | 对缺失场景只支持显式保存，后续补分类 |
| 工作区现有未提交改动均属于用户 | 高 | 当前 dirty worktree | 逐文件手术式修改，不覆盖或清理无关改动 |

## 3. 实现偏差策略

实现中可直接做的保守偏差：

- 复用已有工具、样式和存储函数，删除本次改造产生的重复入口或无用代码。
- 草稿字段缺少可靠证据时留空并要求用户编辑，不编造步骤或权限。
- 自动建议置信度不足时保持沉默，不降低阈值凑功能。
- Web 环境无法镜像原生文件时维持现有本地保存行为，并明确显示环境限制。

必须停止并重新评审的偏差：

- 需要把私人 Skill 写入团队仓库或远端服务。
- 需要绕过现有写入确认、扩大工具权限或自动执行写操作。
- 需要迁移、覆盖或删除用户已有 Skill。
- 现有任务场景无法可靠代表真实工作，导致自动建议前提失效。
- 同一实现阶段出现 3 个以上计划偏差，或出现一个推翻核心前提的意外。

## 4. 机械施工步骤

### 4.1 先锁定现有行为

修改前补或调整测试，证明：

- 现有 Skill 的导入、编辑、复制、启停和删除仍可用。
- 当前重复阈值仍是 3 次、跨 2 天。
- 失败、取消和已有 Skill 不生成新建议。

主要位置：

- `apps/web/src/butler/extensions/learning/*.test.ts`
- `tests/ui/butler-workspace.spec.ts`

### 4.2 增加结构化 Skill 草稿

- 在 learning extension 内新增 `ButlerSkillDraft`、规范化和持久化逻辑。
- 新增纯函数：从完成的 `ButlerTaskState` 与本轮步骤构建草稿。
- 新增纯函数：把草稿渲染成现有 `SKILL.md`。
- 不改变现有 `ButlerSkill` 和 Codex 原生 Skill 的来源模型。

验证：模型单测覆盖合法草稿、空字段、重复名称、危险写权限和 Markdown 输出。

### 4.3 让真实对话产生语义回执

- 在 `askFromPaper` 完成后读取最终 `taskState`，而不是无条件写 `ask:ad-hoc`。
- `completed + scenario !== general` 写入 `workflow:<scenario>`。
- `failed/paused/general` 仍保留统计回执，但不能进入自动 Skill 候选。
- 回执只记录场景、结果、时间和 surface，不复制用户消息正文。

验证：单测和集成测试证明真实完成的候选版本评审可以累计为同一候选。

### 4.4 把 Skill 建议放回对话

- 新增轻量 `ButlerSkillSuggestion`，仅挂在产生候选的最后一条 assistant 结论后。
- 提供“查看草稿”和“先不用”，不提供一键静默安装。
- 用户说“把这套做法保存为 Skill”时，复用同一草稿组件，不另开命令页面。
- 离开对话后，待确认草稿仍可在技能中心继续处理。
- `EfficiencySection` 不再直接安装 `micro-skill`；其他 profile/routine 改进建议保持原行为。

验证：组件测试覆盖自动建议、显式发起、忽略、恢复、保存和重复抑制。

### 4.5 强化而不是删除技能中心

- `ButlerWorkspaceNav` 将 `memory` 的可见名称改为“技能中心”。
- `ButlerIdentityPage` 支持从该入口默认打开 `memory` 页签，保留其他设置页签和 URL/状态兼容。
- `ButlerLearnedPanel` 顶部增加“待确认”草稿区，下面继续展示已安装、原生和插件市场内容。
- 保存成功后触发现有 `skills/changed` 刷新，并允许直接打开刚保存的 Skill。

验证：桌面和移动端均能从侧栏一次到达技能中心；既有市场与管理功能不回归。

### 4.6 收口旧入口和文案

- 删除仅由本次改造替代的 `micro-skill` 通用预览/直接安装分支。
- 保留 learning engine 的候选挖掘，不删除 profile、routine 等非 Skill 能力。
- 用户界面不展示内部 intent、receipt、micro-skill、dry-run 等词。
- 不改与本闭环无关的布局、样式和命名。

验证：搜索用户可见文案和截图，确认只保留自然语言概念。

### 4.7 候选版本验证顺序

1. learning extension 定向单测。
2. Butler store/task-context 定向单测。
3. Web lint、typecheck、测试。
4. `butler-workspace.spec.ts` 桌面与移动关键路径。
5. 本地桌面构建和人工走查。
6. 全量发布门禁；失败则修复后重跑，不带已知错误交付。

## 5. 可观察的验收标准

以下结果全部成立，才算第一阶段完成：

1. 管家完成一次“候选版本评审”后，用户输入“把这套做法保存为 Skill”，当前对话中出现可编辑草稿。
2. 草稿明确显示何时使用、步骤、读取范围、输出效果、确认点、易错点和验证方式，不显示内部键名。
3. 未点击“保存到技能中心”前，不写入或启用任何 Skill。
4. 保存后，Skill 立即出现在技能中心，默认只位于当前 Butler 私有工作区。
5. 同一语义场景成功 3 次且跨 2 天后只建议一次；失败、暂停、普通问答和已有 Skill 不触发。
6. 点击“先不用”后不会在下一次对话立即重复打扰，用户仍可在技能中心找回待处理记录。
7. 技能中心原有本地 Skill、Codex 原生 Skill、插件市场、导入、编辑、复制、启停和删除全部可用。
8. 已保存 Skill 在下一次匹配工作中由现有运行链路按需加载，并以一句轻量说明披露实际使用情况。
9. 桌面和 390px 移动视口无溢出、遮挡、重复弹层或控制台错误。
10. 定向测试、typecheck、构建和候选版本发布门禁全部通过。

## 实现交接

建议在新的实现会话中按 4.1 至 4.7 顺序执行，并创建：

`docs/implementation-notes-butler-natural-skill-learning.md`

内容模板：

```md
# Implementation notes — 管家自然 Skill 学习

Plan: docs/butler-natural-skill-learning-plan.md

## Decisions

## Deviations

## Surprises

## Questions for review
```

实现过程中即时记录决策、偏差和意外，并附具体文件位置；不要等到最后补写。
