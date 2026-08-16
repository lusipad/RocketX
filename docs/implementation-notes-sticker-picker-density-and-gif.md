# Implementation notes — 贴纸面板密度、默认贴纸扩容与 GIF

Plan: `.omx/plans/sticker-picker-density-and-gif.md`

## Decisions

- 面板保留 320px 宽度与 3 列，单格收紧为 64px 高、图片收紧为 40px；点击区域仍高于 44px。
- 静态扩容保持 Twemoji 14.0.2；动态贴纸单独使用 Noto Animated Emoji，避免混淆来源与许可。
- 默认目录现有 21 张静态 Twemoji 与 3 张多帧 Noto GIF，合计 24 张。
- 内置 GIF 使用带 `_gif` 后缀的服务器名称，RocketX 接收时请求 `.gif` 资源；个人导入 GIF 继续保留原 MIME 与原始字节。

## Deviations

- 首轮将网格改为 4 列，视觉门禁得分 72，评语为过于接近高密度表情网格。因此回到 3 列，仅缩小卡片高度与图片，第二轮以 93 分通过。

## Surprises

- 现有个人贴纸库已经识别、保存并通过 Blob 预览 GIF；缺口主要是验证，以及内置服务器贴纸渲染硬编码 `.png`。
- Rocket.Chat 官方服务端对 GIF custom emoji 保留原始字节，但其资源 handler 对非 PNG/SVG 使用 `image/jpeg` 响应头；浏览器仍按 GIF 文件签名解码，需要 UI 测试覆盖。
- UI 回归已使用真实 GIF 字节与 `image/jpeg` 响应头验证这一服务端边界，浏览器正常解码为 512x512 动图资源。

## Questions for review

- 无阻塞项。服务器首次注册内置贴纸仍受 Rocket.Chat `manage-emoji` 权限约束；权限不足时按现有设计回退为图片附件。
