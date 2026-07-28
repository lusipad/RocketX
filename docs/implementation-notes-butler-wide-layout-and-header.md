# Butler 宽屏布局与页头交互修复：实现记录

完成结果：根工作区已覆盖整个主窗口；页头不再混用日期、对话和管理状态；所有可见视图导航统一由 `butlerView` 驱动。

## Plan

- 宽屏：保留内容区的阅读宽度，只让 `.butler-workspace` 填满 `MainPage` 剩余空间。
- 页头：“现在”页面保留日期导航；其他视图不显示日期或重复的对话/管理入口。
- 导航：左侧 `ButlerWorkspaceNav` 是唯一可见的视图切换器；既有程序化入口继续映射到 `butlerView`。
- 状态：移除仅为旧页头 toggle 服务的布尔状态，视图只由 `butlerView` 决定。

## Decisions

- 使用 `flex: 1 1 0%` 修复根容器，不扩大 1080px/760px 内容阅读宽度。
- 移除页头历史和滑杆图标；不换成另一组图标按钮。
- 移除对话和例行页内部与左侧导航重复的“收起”按钮。

## Deviations

- 暂无。

## Surprises

- 现有 1440px 视觉基线无法暴露根容器的 intrinsic width 问题，需要新增超宽断言。

## Questions for review

- 无。

## Verification

- [x] 2048×1200 工作区右边界与主窗口右边界误差不超过 1px
- [x] 非“现在”视图不存在日期导航、历史入口或管理入口
- [x] 5 组响应式视觉基线通过，visual-verdict 98/100
- [x] `pnpm typecheck`
- [x] `pnpm test:regression`：783/783
- [x] `pnpm test:ui`：75/75
- [x] `pnpm build`
