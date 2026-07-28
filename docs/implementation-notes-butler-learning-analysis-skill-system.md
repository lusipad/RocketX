# Butler 学习、工作分析与 Skill 形成系统：实现记录

## Plan

- 设计依据：`docs/butler-learning-analysis-skill-system-design.md`
- 人性化主动系统总设计：`docs/butler-human-presence-system-design.md`
- 当前目标：打通 Profile 学习、工作分析、重复操作识别、改进建议与 micro Skill 形成的第一批闭环，并通过真实界面 dogfooding 验证。

## Decisions

- 采用 Pi Agent 风格的“薄内核 + 可信扩展”：内核只负责扩展依赖、生命周期、事件和命名空间状态，不包含 Profile、工作分析或 Skill 业务知识。
- `runtime.ts` 是学习系统唯一组合根；页面只消费扩展 API，不能自行装配能力。
- 内部扩展宿主只承载随 RocketX 发布的可信扩展；外部 App、权限和副作用仍由既有 `CapabilityBus` 管理。
- Skill 通过 provider 注册为资源；Routine 只引用 `skillName`，不复制 Skill prompt。
- `ProfileFact` 是唯一事实源，`Profile.md` 是可读、可编辑、可重建的投影。
- 明示资料直接确认；行为推断只进入候选，必须由用户确认后才可影响长期行为。
- 操作分析只记录语义级 `OperationReceipt`，不采集键鼠、屏幕、原始输入或消息正文。
- 重复模式按 Task、Profile、MemoryRule、Routine、Tool preset、micro Skill 的顺序分流，避免把所有重复都包装成 Skill。
- 自动化默认先生成建议和预演结果；用户明确启用后才执行有副作用的改进。

## Deviations

- 设计稿提出的完整 `butler.skill.json` effect/verifier 合同没有在第一批全部落地。本轮复用现有原生 `SKILL.md` 文件投影，并把形成流程限制为显式预演和用户确认；自动执行副作用仍不开放。
- 第一批注册 7 个分析/形成 micro Skill，另带一个 `butler-reply-guardian` 行动证明，共 8 个内建 Skill 资源。

## Surprises

- 实现前基线 `pnpm typecheck` 已失败：`apps/web/src/pages/ButlerPage.tsx:313` 的
  `remainingBriefItems` 未被使用。该问题位于当前未提交的 Butler 改造中，已在本轮修复。
- 真实编辑 `Profile.md` 时发现：如果外部编辑删除隐藏 fact 标记，同 kind/subject
  的确认会保留两个 confirmed 版本。修复后，确认新版本会撤销同一事实的旧版本，并新增回归测试。
- 完整 UI 门禁暴露了浏览器测试环境下 Tauri mock 返回空 `butler_home_dir` 时仍尝试
  watch 文件的问题。现在无有效绝对目录时返回空 watcher，扩展激活也会隔离 watcher
  Promise 的失败。
- 中屏成果截图中的会话标题会在异步标题生成后变化。测试现在单独断言选择器可见，
  仅遮罩动态标题文本，成果内容与布局仍完整参与像素比较。

## Questions

- 无阻断问题。外部直接编辑 `Profile.md` 会按“外部来源候选”处理，不能直接覆盖已确认资料。

## Verification

- [x] ProfileFact 状态、撤销与 Profile.md 投影契约测试
- [x] OperationReceipt 隐私边界与工作分析测试
- [x] 重复模式分流、预演和建议测试
- [x] 7 个 micro Skill 资源注册与原生文件投影测试
- [x] Butler 工作台端到端交互测试
- [x] 真实运行 dogfooding：新增显式偏好、外部编辑并确认 Profile 候选、运行工作分析、检查内建 Skill
- [x] 视觉检查：Profile、工作分析和中屏成果工作面
- [x] `pnpm typecheck`
- [x] `pnpm test:regression`：783/783
- [x] `pnpm build`
- [x] `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- [x] 完整 UI 门禁：74/74
