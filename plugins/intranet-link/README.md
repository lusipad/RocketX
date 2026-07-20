# 内网通 RocketX 插件

这是一个独立 RocketX App 插件包，不依赖 RocketX 私有前端模块。安装目录只需要包含本目录的 `rcx.app.json` 与 `index.html`。

## 能力

- `ipmsg.peers`：发现内网通 / 飞鸽 / 飞秋兼容联系人。
- `ipmsg.send`：向选中的旧协议联系人发送聊天消息。
- `ipmsg.offerFile`：由宿主文件选择器选择普通文件，再向旧协议联系人发送邀请；插件不能读取或提交任意本地路径，实际文件由宿主通过 TCP P2P 提供。

## 安装

1. 打开 RocketX 设置页。
2. 进入 Apps。
3. 选择 **Install local app**。
4. 选择本目录。
5. 确认 `lan:discover`、`lan:transfer`、`ui:notify` 权限后安装。

旧协议 peer 始终是未认证 legacy peer，不复用 M9 可信 LAN 身份。
