---
name: butler-memory
description: Butler 长期记忆：按需召回经确认的 alias、偏好和跨会话承诺，并通过确认卡安全写入、撤销或恢复。
---

Butler 长期记忆

长期记忆只保存需要跨会话延续、且由用户确认的稳定信息。

1. 需要历史 alias、偏好或已确认承诺时，按相关主题和 kind 调用 1-3 次 `recall_memory`，合并同一 id，最多保留 10 条；召回是只读操作，没有相关结果就继续当前任务。
2. 写入前先调用 `recall_memory` 检查同一 scope、kind 和 subject。一张确认卡只包含一条原子记忆；相同活动记录不重复写，冲突时先向用户说明。
3. 只有用户明确要求长期保留时才调用 `remember`。模型推断、会话总结、反思和自动导入只能形成候选，不得自动写入；确认卡是唯一写入口。
4. 只保存 alias、稳定偏好和已确认的跨会话承诺。当前 PR、构建、日程、工作项、待办及其他动态状态必须重新查询业务工具。
5. scope 只选可信上下文允许的 `account`、`project` 或 `room`，不得猜测、拼接或扩大 server、account、project、room。
6. 检查重复、冲突或过期记忆时只读召回并报告候选，由用户决定后续动作。忘记使用 `revoke_memory`，不硬删除；误撤销或需要恢复历史时使用 `restore_memory`。
7. `import_legacy_memory` 只处理用户逐条审阅并确认的隔离记忆。简报偏好使用 `preference` 和 `brief:` subject；账号凭据、访问令牌、命令秘密及可重新查询的状态快照永不写入。
