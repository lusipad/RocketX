# Implementation notes — 管家自然 Skill 学习

Plan: docs/butler-natural-skill-learning-plan.md

## Decisions

- 复用现有 learning extension、`saveSkill` 和 Butler 私有工作区，不增加第二套 Skill 存储或执行引擎。
- 首个实现闭环仅覆盖：语义工作回执、对话内建议、草稿确认、私人保存、技能中心直达。
- 自动建议不读取或持久化原始聊天正文；显式保存也只保留会话/消息 ID 与派生草稿。
- 完整对话与“今日纸”两个发送入口统一调用 `recordButlerConversationTurn`，以最终任务状态生成同口径语义回执。
- PR 比较、承诺提取和周报等已有能力使用真实 Skill 名称作为意图键，自动学习不会再生成语义重复的 Skill。
- 草稿中的工具名转换为人话标签，步骤标签去除参数摘要；Skill 正文不带原始目标、步骤详情或搜索参数。
- 自动建议被忽略后，用户再次明确要求保存时会把草稿转成独立显式草稿，不继承旧建议的 `dismissed` 状态。
- “先不用”会持久化为仅隐藏对话卡，草稿继续留在技能中心；再次明确要求保存时会恢复当前对话卡。
- 保存继续走 `saveSkill`；同名 Skill 明确报错，不静默覆盖。保存成功后从技能中心直接打开新 Skill。

## Deviations

- 旧的 `dryRun` / `enable` API 暂留在 learning extension 内，避免影响现有调用与持久化兼容；用户可见的 Skill 直接安装入口已从“分析与改进”移除。
- `ButlerSkillDraft.status` 首版只保留 `draft`；保存或丢弃后直接从待确认集合移除，而不是长期保存 `saved` / `dismissed` 副本。
- 工作区中“私人工作代理”“定时任务”等导航改名是本轮开始前已有的未提交改动，本轮不回退，也不继续扩大该信息架构重命名。

## Surprises

- 真实 `askFromPaper` 路径原本无论任务场景如何都写入 `ask:ad-hoc`；现有端到端 Skill 建议依赖测试手工注入 `workflow:*` 回执，本轮已统一修正。
- 对话存在完整对话与“今日纸”两条真实发送路径，必须同时接入学习回执和显式草稿，否则行为会分叉。
- 独立审查发现“先不用 → 稍后明确保存”会被旧 `proposalId` 隐藏；现已拆开两种状态并新增浏览器回归。
- 复审发现“把这个 Skill 保存为 JSON”会被宽松关键词误判；识别现已要求转换动词直接指向 Skill，并覆盖导出类负例。
- 复审继续发现否定句与转折句边界；识别现按语句顺序以最后一次明确表态为准，并覆盖“不要保存”“后来改口保存”“保存后又取消”以及 `SKILL.md` 文件名等正反例。
- Windows 下 Playwright 用例完成后，Vite 子进程偶发不退出；本轮目标用例输出 `2 passed` 后只终止了对应残留测试服务器进程。
- 生产构建首次发现可空任务的 TypeScript 收窄问题；改为先收窄 `scenario` 后构建意图键，最终构建通过。

## Questions for review

- 无阻断问题。全局术语统一仍应作为独立批次处理，避免与本轮 Skill 闭环混在同一候选范围。
