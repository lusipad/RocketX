# Implementation notes — 管家对标 Codex App

> 文档状态：**历史实施记录**。本文保留迁移决策与兼容取舍，当前用户可见行为见[功能规格](specs/README.md)。

Plan: `docs/butler-codex-parity-plan.md`

## Decisions

- 保留旧 Butler view id 和持久化数据，仅替换用户可见语义，避免无必要的数据迁移。
- 旧自建 Memory 的运行入口全部撤下；历史数据结构和迁移兼容仍保留，避免升级时丢失既有数据。
- 旧 `openButlerPaper` 入口统一重定向到任务页；历史纸面数据与内部视图仍保留，但不能再从产品导航进入。
- `butler-memory` Skill 退出 Codex 工作区，避免它继续要求模型调用已撤下的自建记忆工具；旧 Memory 数据结构与迁移代码保留。
- “已安排”从 Codex `skills/list` 读取全部已启用 Skill，并在执行前使用 Codex 返回的真实路径，支持 Plugin 内的 Skill。
- 删除已失去运行时入口的 `ButlerIdentityPage` 及 438 行专属样式，避免继续维护“了解你/技能中心”这套旧信息架构；底层身份数据与运行指令保留兼容。

## Deviations

## Surprises

- `apps/web/src/stores/butlerCodex.ts` 已完整接入 Plugin 和 `thread/memoryMode/set`，但常驻线程创建和恢复后都主动将原生 Memory 设为 `disabled`。
- `apps/web/src/stores/butler.ts` 与 `apps/web/src/stores/routines.ts` 会把自建 Memory 文本注入每次交互和例行任务。
- 显式传入 `skillName` 时原实现默认拼接 `.agents/skills/<name>/SKILL.md`，Plugin Skill 会因此指向错误路径。

## Questions for review

- Codex realtime 语音协议已生成，但当前客户端未接入；按计划留到统一控制层稳定后的独立迭代。

## Verification

- 逻辑回归：98/98 通过，覆盖原生 Memory、Plugin Skill 真实路径、审批边界、定时触发和身份兼容。
- 新控制台 UI：7/7 通过，覆盖任务、动态、已安排、插件、设置、宽屏与 390px 窄屏。
- 既有管家交互：44/44 通过，覆盖图片输入、确认卡、ADO 零写保护、任务历史、房间上下文和后台任务。
- 跨模块核心流程：3/3 通过，覆盖返回消息、确定性待办界面和任务上下文保持。
- `pnpm --filter @rcx/web typecheck` 通过。
- `pnpm --filter @rcx/web build` 通过；仅保留仓库既有的 Vite 动态导入和大 chunk 警告。
- 视觉门禁：93/100，通过；结果见 `.omx/state/butler-codex-parity/ralph-progress.json`。
- 旧用户概念扫描无命中：`技能中心`、`今日纸`、`了解你`、`管家委托` 等不再出现在活动页面与组件中。
