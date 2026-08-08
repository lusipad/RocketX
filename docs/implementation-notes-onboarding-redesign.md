# Implementation notes — onboarding redesign

Plan: `.omx/plans/onboarding-redesign-kickoff.md`

## Decisions

- 首屏采用方向 D 的 GTD 与注意力结构，只保留一个主要动作，再进入团队或个人设置。
- 团队配置导入、Rocket.Chat 探测和个人凭据隔离保持原实现，不改变配置格式或存储版本。
- 第二步用“消息、工作台、管家”的职责分工承接理念，Skill 只作为管家的按需能力出现。

## Deviations

- 本轮只改造首次运行页面，不增加登录后的示例覆盖层；首次成功引导留待后续独立验证。

## Surprises

- 现有页面已经包含 GTD 文案，但配置表单与理念同时出现，首屏仍然以配置任务为主。

## Questions for review

- 桌面与 390px 移动布局是否都能先理解理念，再顺畅完成团队配置导入。
