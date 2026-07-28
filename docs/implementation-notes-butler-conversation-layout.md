# Implementation notes — 管家完整对话双栏布局

Plan: `docs/butler-conversation-layout-plan.md`

## Summary

已按计划完成桌面会话历史侧栏、独立消息滚动区和常驻 Composer；中屏与移动端
回落为紧凑会话选择器，输入仍固定在 viewport 底部。会话、消息、审批和持久化
继续由原 `useButler` store 负责，没有引入第二套状态。

## Decisions

- 复用 `useButler.sessions` 作为唯一历史来源，不新增会话状态或持久化。

## Deviations

- 计划最初把“在办”一并移入消息滚动区。既有回归明确要求已派出的活独立于聊天记录，
  因此恢复为 header 下方的限高折叠区；Composer 仍由修复后的高度链固定在底部。

## Surprises

- `ButlerConversation` 本身已经是 header / scroll / footer 的 flex 结构，但移动断点下
  `.butler-workspace-stage` 同时保留 `height: 100%` 并位于带顶部导航的 column flex 中，
  实际高度变成“整个视口 + 顶部导航”，Composer 因而被裁到屏幕下方。移除该固定高度，
  让 `flex: 1` 和 `min-height: 0` 决定剩余空间。
- 仅修正 stage 后中屏 Composer 底边仍在 1123px。继续沿 DOM 高度链检查，发现
  conversation 专属内容外还有一层无 class 的包装 `div`，使子级 `height: 100%` 无法
  解析。该层只在 conversation 分支补 `h-full min-h-0`，不影响其他工作视图。

## Questions for review
