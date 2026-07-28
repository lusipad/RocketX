# Implementation notes — 管家设计语言统一

Plan: `docs/butler-design-language-unification-plan.md`

## Summary

已开始统一导航层级。首先让全局导航、管家导航和会话历史使用同一密度、圆角与选中逻辑。

## Decisions

- `apps/web/src/styles.css:258`：管家二级导航跟随 RocketX 主导航的 210px 宽度、15px 导航字号和 36px 行高。
- `apps/web/src/styles.css:425`：二级导航与会话列表选中态改用 `fill-active + ink`，强调色只承担图标和关键状态。
- `apps/web/src/styles.css:510`：页面级标题统一为 20px，分组标题统一为 16px，承担说明作用的正文使用 `ink-2` 而不是低对比 `ink-3`。

## Deviations

## Surprises

- `apps/web/src/styles.css:39-48` 已经把全局正文档位统一到 15px、元信息统一到 13px，但 Butler 专属 CSS 又写入了大量 10–13px 硬编码，视觉漂移来自局部样式绕开现有主题阶梯。

## Questions for review
