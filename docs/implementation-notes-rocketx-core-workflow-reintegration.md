# RocketX 核心工作闭环重新整合实施记录

Plan: `docs/rocketx-core-workflow-reintegration-plan.md`

## Summary

尚未开始业务代码实施。Kickoff 已完成现状核验、路线选择、职责归属和验收标准。

## Decisions

- 采用“保留能力、重整表面”，不做候选版本前的数据模型重写。
- 主工作入口收敛为消息、今天、管家；设置保留为固定工具入口。
- 现有消息过滤承担 Activity 分诊，不新增 Activity 模块。
- Today 负责定向，管家负责行动；旧 `now` 仅作为待迁移兼容标识。

## Deviations

## Surprises

- `apps/web/src/pages/WorkbenchPage.tsx` 虽已命名为“今天”，仍保留 ADO 工作台标签、自定义查询和收藏夹；重命名没有完成职责迁移。
- `apps/web/src/pages/ButlerPage.tsx` 仍渲染完整 `now` 驾驶舱和第二套 Composer；表面导航精简后，重复产品仍在内部存在。
- `apps/web/src/components/NavRail.tsx` 的模块分组与 Store 解耦，允许先隐藏入口并保留深链，减少了数据迁移风险。
- 工作树已有大量与 Butler、Skill、MCP 和候选版本相关的未提交改动；实施必须按文件和行为边界做手术式修改，不能用大范围还原或格式化。

## Questions for review

- 如果全局搜索无法可靠打开隐藏模块，实施切片 1 应增加单一“更多工具”入口，而不是恢复多个主导航项。

