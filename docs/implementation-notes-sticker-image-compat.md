# Implementation notes — Rocket.Chat 原版兼容贴纸图片

Plan: `.omx/plans/sticker-image-rocket-chat-compat.md`

## Decisions

- 只对“内置 `twemoji` + 输入框为空”启用服务器自定义表情协议；带说明文字的贴纸保持原附件协议。
- RocketX 对整条单一 `rocketx_sticker_*` shortcode 在 Markdown 之前截获，使用 `AuthImage` 渲染为块级贴纸，因此桌面远程服务器可带认证读取，且不受 `useEmojis` 偏好影响。
- 创建资源时写入稳定 ownership alias；同名但没有 marker 的资源视为冲突并回退附件。
- 并发首次创建遇到同名冲突时重新查询；若资源带 ownership alias，则继续发送 shortcode，否则按外部冲突回退附件。
- 不缓存服务器探测结果，避免跨服务器或账号污染。

## Deviations

- 无 `manage-emoji` 权限或遇到同名冲突时，当前版本仍回到既有 `UploadConfirm` 附件发送链路，并追加一次轻提示；未知网络/服务错误不做静默降级。
- `401` 代表登录态失效，不会伪装成权限不足并静默回退。

## Surprises

- 同一透明 PNG 改为 RGBA、WebP、GIF 或增加透明留白后，Rocket.Chat 普通附件仍会填充方形背景；这不是源图透明通道问题。
- 同一 PNG 注册为 Rocket.Chat 自定义表情后，原版客户端会保留透明轮廓。
- `emoji-custom.create` 的 `aliases` 需要逗号分隔字符串，而 `emoji-custom.all` 返回的是数组；REST 层做了最小规范化，避免 UI 自己拼接/拆分。

## Verification

- 服务器兼容与边界回归：13 项通过。
- 自定义表情 REST 契约：4 项通过。
- 贴纸库既有回归：19 项通过。
- 新增 UI 链路：2 项通过；既有贴纸 UI：3 项通过。
- Web 与 `rc-client` 类型检查通过；视觉对比评分 94/100，通过。
