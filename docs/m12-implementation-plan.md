# M12 管家多会话调查与地基收口实施计划（Issue #168 / P0）

蓝图：[`blueprint.md`](blueprint.md) §4.7.2、§4.7.2a、§4.7.4
当前版本：v0.26.x 工作树基线（2026-07-22）
Issue 角色：#168 作为 umbrella；本文件只定义 P0 地基与 P1-P6 架构 phase，不声称后续阶段已实现。

## 1. 最可能调整的决定

### 1.1 P0 只交付地基，不提前做 P1 代码

本阶段只交付三样东西：

1. ADR 级实施计划，明确 P1-P6、依赖、验收、非目标和风险。
2. 七类真实任务场景的可执行 scenario baseline，锁定当前 Butler 的真实能力与明确缺口。
3. 迁移/回滚作为贯穿合同写清楚，而不是混成某个单独 phase 的功能点。

P0 不实现新的多 session UI、context compiler、engine contract、typed tool runtime、scoped memory
或 rounds/workflows 合流；首个后续代码切片固定为 **P1 多 session / transcript / 去 3 天 TTL**。

- **Confidence: high**
- **What would flip it**：如果 #168 被拆成多个更小 umbrella 或用户要求把 P1 直接并入本次交付，那需要重开计划，
  而不是在 P0 文档里偷偷扩 scope。

### 1.2 当前 Butler 持久化 scope 是 `server scope + userId`，不是固定 `same-origin`

当前 `apps/web/src/stores/butler.ts` 与 `apps/web/src/stores/today.ts` 的实际 scope 都是：

```ts
`${getServerBase() || 'same-origin'}:${user._id}`
```

因此：

- 测试环境或同源 Web 部署时，scope 会退化成 `same-origin:<userId>`。
- 桌面端或显式配置 Rocket.Chat 地址时，scope 是 `<serverBase>:<userId>`。
- 这仍然只承载**单个 Butler 会话**，不是多 session registry。

文档、测试和后续迁移设计都必须基于这条事实；不能把测试环境的 `same-origin` 误写成产品固定合同。

- **Confidence: high**
- **What would flip it**：如果 Butler store 在别处还叠加了未发现的二级 session key；当前仓库证据没有显示这一点。

### 1.3 迁移/回滚是贯穿合同，不属于单一架构 phase

当前档案事实已经是：

- persona / memory / skills / routines / routine-seen 的新主仓是 `rocketx.butler/archive`
- 旧 `rcx-butler-v1:*` 键仍保留作 fallback 读取源
- 空 IndexedDB 时从 fallback 导入；已有 IndexedDB 时以新仓为准

P1-P6 都必须遵守同一条合同：

- 先增加新结构，再迁移读取/写入路径
- 保留旧数据源直到有独立回归证明可以删除
- 回滚必须能恢复旧读取路径，不得要求人工拼数据

因此迁移/回滚是 cross-cutting concern，不单独归入 P2，也不应该占掉一个架构 phase。

- **Confidence: high**
- **What would flip it**：只有在发现旧键本身构成安全/一致性风险时，才允许进入显式清洗阶段，但仍需要独立回归证明。

### 1.4 P1-P6 架构 phase 固定为以下顺序

| Phase | 目标 | 关键依赖 | 验收摘要 | 非目标 | 主要风险 |
|---|---|---|---|---|---|
| P1 | 多 session / transcript / 去 3 天 TTL | P0 scenario baseline、现有单会话持久化事实 | 同账号下可并存多个 Butler session；每个 session 有独立 transcript、标题、最近活动与恢复点；恢复不再依赖 3 天 TTL 切断上下文 | 不做 context compiler、typed runtime、主动 rounds | session key 或 transcript schema 设计失误污染现有 `builtin:butler` 数据 |
| P2 | context compiler + manifest + task state | P1 session/transcript 模型 | “找文件 / 比较 PR / 提取承诺 / 跟进草稿 / 构建关联”等任务有结构化任务态、预检与来源 manifest | 不统一 API/Codex engine，不上写动作 | compiler 粒度过粗，导致澄清、来源和错误动作不可追踪 |
| P3 | API/Codex 共用 engine / session contract | P1 session、P2 task state | API/Codex 共用 session lifecycle、resume、transcript、status 与 task-state contract；不再一条脑一路状态机 | 不做 typed tool approval runtime | 双脑行为继续分叉，后续 phase 无法共用验证 |
| P4 | typed tool runtime + preflight + approval / checkpoint | P2 compiler、P3 engine contract | 写动作、草案、审批、checkpoint、恢复点进入统一 typed runtime；错误动作和恢复路径可验证 | 不扩长期记忆边界 | 审批点不统一，副作用绕过工具层 |
| P5 | scoped memory | P2 task state、P4 typed runtime | 记忆从“全局文本堆”收敛到有 scope 的别名/偏好/承诺边界；支持跨 session 但不串污染 | 不做主动 rounds | 动态工作数据误写入长期记忆，或 session 间泄漏 |
| P6 | 主动 rounds / workflows 合流 | P1-P5 稳定 | today / watcher / rounds / workflow 统一挂到同一 Butler task-runtime，上报、追踪与恢复一致 | 不做新导航重构 | 主动执行和手动调查分叉，形成第二套状态机 |

### 1.5 六个建议子 Issue（对应 P1-P6）

| 子 Issue | 建议标题 | 依赖 | 验收 | 风险 |
|---|---|---|---|---|
| #168-P1 | Butler 多 session transcript 与 TTL 移除 | P0 | 可创建/切换/恢复多个 session；旧单会话自动迁入默认 session；3 天 TTL 不再截断恢复 | 旧数据迁移和新 registry 打架 |
| #168-P2 | Butler context compiler、scenario manifest 与 task state | P1 | 七类任务都有结构化预检、来源、澄清、错误动作、恢复态 | compiler 过度硬编码，新增任务难扩展 |
| #168-P3 | Butler API/Codex 共用 engine 与 session contract | P1, P2 | API/Codex 共用 transcript / task-state / resume 合同 | 双脑历史债务导致 contract 失真 |
| #168-P4 | Butler typed tool runtime、preflight、approval 与 checkpoint | P2, P3 | 所有写动作/草案/审批都进入 typed runtime；失败后可 checkpoint 恢复 | 审批点遗漏导致副作用越界 |
| #168-P5 | Butler scoped memory 与 alias/commitment 边界 | P2, P4 | 记忆按 scope 治理，动态工作数据不入长期记忆 | 记忆作用域过宽或过窄，影响体验 |
| #168-P6 | Butler 主动 rounds 与 workflow runtime 合流 | P3, P4, P5 | rounds / watcher / workflows 与手动调查共用同一 runtime 与记录 | 主动流程压垮已有 Today / routine 体验 |

## 2. 七类真实任务场景基线矩阵

| 任务场景 | 完成 | 能力预检 | 来源 | 错误动作 | 澄清 | 恢复 |
|---|---|---|---|---|---|---|
| 找昨日某人文件 | 部分 | 已知发送人、日期、是否带文件时可检索；别名/多候选还没 compiler | `search_messages` | 不会发消息、改数据或写文件 | “某人”不是明确姓名时缺少体系化澄清 | 可重查；结果不形成独立调查 session |
| 比较两个 PR | 部分 | 能列候选 PR；缺少比较器和结论层 | `list_pull_requests` | 不会评论、合并或改 PR | 用户没给 PR 编号时只能靠关键词列候选 | 可重查；比较仍靠人工 |
| 群聊提取承诺 | 缺口 | 只能返回原始消息，缺少承诺提取与 task-state | `search_messages` | 不会静默建待办/工作项/记忆 | 没有“承诺/负责人/截止时间”的结构化澄清层 | 可重搜原文；提取仍靠人工 |
| 逾期 WI 跟进草稿 | 部分 | 能列逾期工作项；缺少跟进草案、审批和 checkpoint | `list_work_items` | 不会自动催办或修改工作项 | 不会追问催办对象、口径和投递面 | 可重查；草稿仍需人工整理 |
| 构建失败关联提交 | 缺口 | 能列失败构建；没有提交/变更关联层 | `list_builds` | 不会自动重试、回滚或动代码 | 不会追问仓库、PR、变更范围 | 可重查失败构建；关联提交要后续 typed runtime |
| 创建周报例行任务 | 完成 | 已有 `weekly-report` 技能 + `draft_routine` 草案闸门 | `load_skill`、`draft_routine`、`routines` store | 不会绕过确认直接启用 | 技能名/时间/星期非法会直接拒绝 | 可重新生成草案并确认 |
| 跨重启续跑 | 部分 | 同一 `server scope + userId` 下可恢复共享 Butler 会话；仍受单 session 约束 | `builtin:butler` 持久化、`useButler.hydrate` | 不会跨账号或跨服务器串历史 | 没有多 task state / transcript session | 同 scope 可恢复；超 TTL 仍只回看不续跑 |

## 3. Assumptions

- `docs/blueprint.md` §4.7.2a 的双脑决定仍然有效；高置信，当前代码与回归都按该合同运行。
- #168 的核心不是换模型，而是把单 Butler 会话演进为可管理的多 session 调查系统；高置信，来自架构审计与任务矩阵。
- 现有 `createButlerTools()`、`draft_routine`、`remember`、`load_skill`、watcher 和 Today 仍可复用；高置信，本轮没有发现必须推倒重来的底层契约。
- P0 不新增依赖；高置信，当前只调整测试与文档。

## 4. Deviation policy

边角问题默认选保守方案：**先记录缺口，再补能力；先保留旧数据，再引入新结构；先完成预检，再开放写动作。**

- 任何 scenario 做不到都可以记成“部分”或“缺口”，但必须有可执行证据。
- 任何 phase 都不得把迁移/回滚省略成“后面再看”，因为它是跨 phase 合同。
- 双脑行为若有分叉，先收敛到共用 session / task-state contract，再修具体执行体验。
- P1 之前不删除 `builtin:butler` 单会话键，也不删除 `rcx-butler-v1:*` fallback 键。

以下情况必须停止并重新确认：删除旧数据源、把只读调查流变成写路径、默认自动创建工作项/PR/消息、
扩大 Butler 对仓库或本机文件的访问范围、引入新的外部依赖或远端服务。

## 5. 机械工作（低审阅价值，信任实现者）

1. 把 `scripts/regressions/butler-runtime-baseline.test.ts` 改造成七类真实任务的 scenario baseline。
2. 在文档里纠正 `server scope + userId` 持久化事实。
3. 按架构审计重排 P1-P6，并补六个建议子 Issue。
4. 仅跑与 Butler scenario baseline、关联回归和 `@rcx/web` typecheck 直接相关的验证。

## 6. Verification

- `scripts/regressions/butler-runtime-baseline.test.ts` 通过，且覆盖七类真实任务场景。
- 关联既有回归继续通过：`butler-archive`、`butler-store`、`butler-context-freshness`、
  `butler-codex`、`butler-brain`、`butler-persistence`。
- `pnpm --filter @rcx/web typecheck` 通过。
- `git diff --check` 为零。

## 7. Non-goals

- 本轮不实现 P1-P6 的产品代码。
- 不修改 `apps/web/src/stores/butler.ts`、`butlerCodex.ts`、`butlerArchive.ts` 的运行逻辑。
- 不删除旧 `rcx-butler-v1:*` 键，不做任何提交、推送、Issue/PR 创建或 worktree 清理。

## 8. Handoff

P1 开工前先读本文件与 `docs/implementation-notes.md` 的 M12 段，然后按以下顺序执行：

1. 建多 session / transcript registry，并让旧单会话迁入默认 session。
2. 去掉 3 天 TTL 截断，把“恢复”交给 transcript / task state，而不是时间阈值。
3. 在 session 之上做 context compiler、scenario manifest 与 task state。
4. 再把 API/Codex 收敛到共用 engine/session contract。
5. 最后才上 typed runtime、scoped memory、rounds/workflow 合流。

P1 完成前，不得在文档或 UI 中声称 Butler 已具备完整多 session 调查能力。
