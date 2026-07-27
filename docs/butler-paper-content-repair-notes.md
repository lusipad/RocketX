# 管家纸面真实内容修复记录

Plan: [butler-paper-content-repair-plan.md](./butler-paper-content-repair-plan.md)

## 发现

- `NavRail` 直接统计 `useTodos.todos` 中未完成项，因此截图里的红色 `1` 是真实状态。
- `ButlerPage` 只读取派活和 rounds 简报；`paperEmpty` 完全没有检查待办。
- `runDailyButlerRoundsIfNeeded()` 的 `running` / `error` 也没有呈现，整理失败会被误画成“今天还没有事”。
- 现有 UI 回归明确锁定了“创建待办后管家纸仍为空”，这条旧设计合同需要改写。

## 实施记录

- `ButlerPaperViewModel` 增加当天未完成待办投影；完成项过滤，截止日优先，无截止日按新到旧。
- 管家纸新增紧凑“待办”区：最多 5 项、行内完成、进入全部待办和必要元数据。
- rounds 命中同一待办时，原因与建议折叠在该行，不再在“今天”重复标题。
- rounds 的运行和失败状态改为原位反馈，失败可重试；两种状态均不会误显示空纸。

## 验证记录

- 红灯：纯回归缺少 `visibleButlerTodos`；Playwright 找不到“待办”区域。
- 绿灯：纸面纯回归 6/6；目标 Playwright 2/2。
- Web `tsc --noEmit` 通过；Vite 生产构建通过，1891 个模块。
- 全仓回归 761/761。
- 本地桌面真实账号验证：1 条逾期待办、来源、折叠的 AI 原因和建议均可见，空状态不再出现。
