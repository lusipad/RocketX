# 原生 `@ai` 提及交互实现记录

## 目标

让共享 AI 托管在 RocketX 的提及候选里成为一等入口，同时继续使用既有房间 session 与消息路由。

## 保持不变

- 个人“房间 AI”仍是仅当前用户可见的独立会话。
- `@ai` 仍然只是共享托管指令文本；不会创建第二条 AI 会话。
- 模型、Agent、权限和托管启停仍由现有配置与控制面负责。

## 实现

- 主消息 Composer 将共享 AI 作为虚拟 mention 候选接入现有列表，并固定在模糊匹配结果之前。
- ThreadPanel 使用相同的 session 判定和文本插入规则，不创建第二条托管会话。
- 候选只订阅当前作用域的状态字符串；其它房间的托管心跳不会让输入组件重渲染。
- 同名真实成员 `ai` 在共享 AI 候选存在时被去重，且虚拟候选不会进入群外成员邀请路径。
- 候选采用单行原生列表结构：机器人图标、`AI 托管`、`@ai` 和 `房间共享`/`话题共享` 标识。

## 验收证据

- `pnpm exec tsx --test scripts/regressions/ai-mention.test.ts scripts/regressions/issue-251-dm-mentions.test.ts scripts/regressions/agent-context.test.ts`：17/17 通过。
- `pnpm test:ui -- tests/ui/ai-mention.spec.ts tests/ui/issue-251-dm-mentions.spec.ts`：3/3 通过。
- `pnpm --filter @rcx/web typecheck`：通过。
- 视觉门禁第一轮 84 分；按反馈收敛成单行后第二轮 93 分，通过。
- 代码复核：0 个遗留问题，APPROVE。

本功能纳入 `v0.43.0`。
