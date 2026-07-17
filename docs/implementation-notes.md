# Implementation notes — M8 共享 Agent 与反向 MCP

Plan: `docs/m8-implementation-plan.md`

## Shipped vs planned

- Rocket.Chat 话题现在承载共享 Codex 长会话：指令先成为普通消息，完整回复回到话题，过程事件只留在本机 Agent 面板。
- 宿主租约、成员首次指挥审批、危险动作审批、串行指令队列、进程中断和 thread resume 均已落地。
- 反向 MCP 以 `rocketx.exe --mcp` 提供三个只读 Rocket.Chat 上下文工具；可选 Agent Bot 只负责完整回复。

## Decisions

- 协议基线锁定为 `codex-cli 0.144.4`；生成类型与真实 stdio 握手均以同一二进制验证。
- Rust 只负责每会话一个固定 Docker Runner、JSONL 传输和容器回收，TypeScript 负责协议语义、会话和审批。
- Runner 只挂载当前会话工作区、独立 Codex 会话目录、只读临时附件和一个只读认证文件；宿主其他路径不进入容器。
- 当前 11 类 server-initiated request 必须显式处理，未知请求安全拒绝。
- 上下文包包含当前话题、被引用消息的整条已加载线程、参与者和消息中关联的 ADO 工作项；站内代码、日志、图片附件限量写入应用缓存并只读挂载，不写入用户项目。
- 正常结束会话时清理临时附件；进程中断时保留，以便同一 Codex thread 恢复后继续引用。
- Codex 默认只读；工作区写入和执行动作必须由当前宿主审批，显式敏感路径请求和审批命令会被拒绝。
- MCP 与 Bot token 只存 Windows 凭据库；Bot 发送前还必须匹配当前 Rocket.Chat 服务器，避免切换账号后跨服务器代发。

## Surprises

- 本机 PATH CLI 为 `0.144.4`，桌面内置 CLI 为 `0.144.2`；两者都能握手，但不能共享同一份未校验的协议绑定。
- 当前服务端主动请求面比蓝图列举更宽，包含认证刷新、attestation、当前时间和旧版审批兼容请求。
- PowerShell 不会按 CLI 管道语义等待 Windows GUI 子系统程序；release MCP 必须用真实客户端的子进程 stdio pipe 方式验证，不能用 PowerShell 管道是否有输出判断。
- Windows 原生 sandbox 无法兑现读隔离；Linux Runner 还需要为 npm 包内的 Codex 原生二进制提供 `codex-linux-sandbox` argv0 入口，才能让 bubblewrap 权限配置真正执行。

## Verification

- `codex app-server generate-ts --experimental` 已生成 671 个类型文件，`pnpm codex:protocol:check` 确认无漂移。
- `pnpm smoke:codex-app-server` 在真实 `0.144.4` 进程完成 initialize、thread/start、turn/start、流式响应和 turn complete。
- `pnpm agent:runner:test` 验证固定 0.144.4 镜像、只读/可写双配置、只读上下文附件、根目录与嵌套 `.env`、通用 credentials 文件、Codex 认证文件拒绝。
- `pnpm smoke:agent-runner` 完成真实模型读取只读上下文附件、宿主逐次批准写入，并在强制移除容器后以同一 threadId resume 完成第二轮。
- `pnpm test:pure`（219）、`pnpm test:regression`（229）、`pnpm smoke`（53）、`pnpm test:classify`（5）、`pnpm typecheck`、`pnpm build` 全部通过。
- `cargo test --locked`（14）通过；`tauri build --no-bundle` 生成 v0.17.0 release 二进制。
- Node 子进程以 stdin/stdout pipe 启动 `rocketx.exe --mcp`，initialize 返回协议 `2025-06-18`，tools/list 仅返回三个只读工具；专用测试账号可列出 54 个授权会话并读取其中一个，随机私有房间被拒绝。
- 仓库及待提交 diff 的密钥样式扫描为零命中；合成密钥脱敏测试使用运行时拼接，避免假阳性。

## Verification limits

- 本轮 Windows Computer Use 官方 JavaScript 能力列表为空，无法完成 Agent 面板的真实窗口视觉验收；协议、状态机、生产构建和 release 进程路径已由自动化与真实子进程覆盖。
- 共享 Agent 现在依赖正在运行的 Docker Desktop；AI 设置页提供状态诊断和一键构建固定 Runner 镜像，不会在 Docker 缺失时退回不安全的原生进程。

## Questions for review

- 无。

---

# Implementation notes — M9 LAN P2P 与断网降级

## Shipped vs planned

v0.18.0 已交付 mDNS + UDP 组播发现、Rocket.Chat 认证通道设备公钥交换、Ed25519 双向挑战应答、可信 LAN 消息、IndexedDB 作者 outbox，以及原生四流文件传输。IPMSG 仍按蓝图留给 M10。

## Decisions

- 广播只做发现；信任只能来自已认证 Rocket.Chat 消息中固定的设备公钥。
- 文件路径不经过 WebView IPC。桌面文件选择保留原生路径，Rust 分片读取并发送；P2P 不可用时才回到现有 Rocket.Chat 上传。
- 回灌不提交服务器拒绝的历史 `ts`。customFields 可用时携带原始时间，不可用时只在参与原 LAN 会话的设备本地保留。
- 群聊文件暂走 Rocket.Chat；只有可信单人会话自动直传，避免部分群成员 P2P 成功后再回退服务器造成重复附件。

## Deviations

- 本地 Rocket.Chat 的上传上限为 100 MiB，无法执行 5 GiB 服务端上传；验收记录为“P2P 57.643 秒完成、服务端配置拒绝”，未临时修改管理员设置。
- 物理拔线由可重复的连接中断 + 持久化缺块故障注入替代，覆盖相同续传状态机且不影响用户机器网络。

## Surprises

- Windows 非阻塞监听器接受的连接会继承非阻塞状态；真实四流测试复现 `WSAEWOULDBLOCK`，所有连接现显式切回阻塞 I/O。
- Rocket.Chat 8.6.1 对重复自定义 `_id` 保持单条历史，但第二次 REST 请求返回内部错误；回灌必须按 ID 回查，不能只看请求状态。

## Verification

- 5 GiB 四流回环：57.643 秒，约 88.8 MiB/s，最终 BLAKE3 一致。
- RC 8.6.1：自定义 `_id` 幂等落库；历史 `ts` 被拒；customFields 未启用。
- Rust 覆盖固定公钥握手、冒充/重放拒绝、路径穿越、损坏分片、缺块续传、离线聊天和真实多流 TCP。

## Questions for review

- 无。

---

# Implementation notes — M10 IPMSG 共存模式

Plan: `docs/m10-implementation-plan.md`

## Decisions

- IPMSG peer 明确建模为未认证旧协议身份，不复用 M9 的 `LanPeer`、固定公钥或可信标记。
- 固定端口 2425 绑定失败时保持关闭并返回错误；不换随机端口制造“已上线但旧客户端发现不到”的假状态。
- 旧编码集中在 native codec：标准未声明 UTF-8 时用 CP932，飞秋 fixture 方言用 GBK。

## Deviations

- 真实飞秋二进制因 HTTP、无签名、公开 7/73 告警且当前宿主无 Defender/Sandbox 而不执行；按蓝图预设降级为官方 IP Messenger 真实验收，飞秋只做 fixture 兼容。

## Surprises

- IPMSG 的 NUL 有两种语义：成员报文中分隔 nickname/group，`FILEATTACHOPT` 消息中分隔正文/附件元数据；codec 必须结合 command 位解释，不能只按字节盲切。
- 官方 IP Messenger 5.8.3 的 `ipcmd` 文件邀请把 32 位文件 ID 输出为十进制，而 `GETFILEDATA` 仍要求该数值的十六进制形式；真实客户端验收据此加入了窄范围兼容解析。

## Questions for review

- 无。

---

# Implementation notes — 消息搜索无限滚动

## Shipped vs planned

消息搜索仍以 20 条作为首批展示量，但不再把它作为结果总上限。用户滚动到底时，已有的匹配结果会立即分批展开；需要更早结果时再继续请求服务器。

## Decisions

- Rocket.Chat 默认全局搜索提供器只有 `limit`，因此每次续页把请求上限扩大 20 条，并按消息 ID 去重合并。
- 全局搜索不可用时使用 `chat.search` 官方 `offset + count` 参数，对全部可访问会话以两路并发请求下一页。
- 本机已加载消息仍只提供最近 20 条即时结果，避免首次输入时扫描结果直接撑大界面。
- 成功搜索缓存从最近 20 个查询缩减到 5 个；首批超过 200 条时不跨查询缓存，完整分页结果只在当前搜索面板存活期间保留。

## Deviations

- 没有引入本机持久化全文索引。逐会话回退的后续页仍取决于 Rocket.Chat 房间数量和服务端搜索速度。

## Surprises

- 默认全局搜索提供器支持扩大 `limit`，但没有 offset；房间级 REST 搜索则支持 offset，两条路径不能共用同一种分页游标。

## Verification limits

- 本地 Rocket.Chat smoke 已用两条中文匹配消息验证 `count=1` 时 `offset=0/1` 返回不同结果。

## Questions for review

- 无。

---

# Implementation notes — M6 扩展内核与自动更新

## Shipped vs planned

已完成蓝图 M6 的 7 类首批扩展点、Manifest/安装/生命周期、三档权限闸门、iframe/worker 运行时、JSON-RPC Bridge、统一输入派发、IndexedDB 存储和 SDK v0。另按 T1 接入桌面自动更新与 GitHub Releases 签名产物。

## Decisions

- iframe Bridge 使用每次文档加载独立的 `MessageChannel`；iframe 自导航后不重建通道，防止窃取旧 `WindowProxy` 能力。
- iframe 文档仅允许内联/data/blob 资源，`connect-src 'none'`；所有网络请求只能通过宿主能力总线并同时通过权限与 `netAllow` 校验。
- Tauri HTTP 不再给主窗口静态宽权限，而是在宿主明确请求前按精确 origin 建立动态 ACL；子 iframe 因 remote context 与 Tauri ACL 不匹配而无法绕过 Bridge。
- worker 只允许本机显式安装的可信应用，且屏蔽网络、IndexedDB、缓存、RTC 和嵌套 worker 入口；它是能力边界，不声称是密码学隔离。
- native/mcp 进程形态和危险权限的每次审批卡片依蓝图留到 M8 `proc.rs`；M6 已预留 scope 并硬性禁止远程应用申请。

## Verification

- 真实 Tauri 窗口：动态 HTTP 授权后登录 Rocket.Chat 8.6.1；Hello 应用显示 Tauri ACL 阻断 iframe IPC，Bridge 通知成功。
- Hello 导航与 `/hello` 补全可用；Kanban 可读当前会话并将现有消息转为卡片。URL 安装使用错误包哈希时被拒绝，更正后才安装。
- `pnpm typecheck`、`pnpm build`、`pnpm test:pure` (219)、`pnpm test:regression` (174)、`pnpm smoke` (53)、`pnpm test:classify` (5)、`cargo check --locked`、`cargo test --locked` (4) 全部通过。
- `tauri build --no-bundle` 完成 Windows Release 链接并生成 `target/release/rocketx.exe`。

## Verification limits

- 本地目录安装会触发 WebView2 的文件上传确认；本轮不替用户点击该高影响确认，目录解析/安装/卸载改由回归测试验证，真实窗口用 URL 安装路径验收。
- updater 签名私钥仅保存在 GitHub Actions Secret；本地不保留私钥，完整安装包、`.sig` 与 `latest.json` 需由标签发布流水线验证。

## Questions for review

- 无。

---

# Implementation notes — 受控消息搜索范围

Plan: 当前任务中的“默认轻量搜索 + 显式搜索全部”实施计划。

## Decisions

- 默认远端搜索只覆盖当前会话；本机已经加载的其它会话消息仍即时参与结果。
- “搜索全部”是显式深度搜索开关，点击后才请求跨会话全局搜索或逐房间回退。
- 分页继承发起搜索时的范围，局部搜索滚动不会自动升级为全量搜索。

## Deviations

- 无。

## Surprises

- Rocket.Chat 默认提供器即使关闭全局搜索，仍可用同一方法搜索当前房间；只有 `searchAll: true` 需要全局开关。

## Verification

- Windows Tauri 开发版已实机确认：输入关键词后显示“搜索全部”，点击后先显示全会话搜索进度，完成后范围状态切换为“全部会话”；按钮、状态条和搜索结果区均无溢出。

## Questions for review

- 无。

---

# Implementation notes — v0.14.9 搜索渐进补全

## Shipped vs planned

全局搜索先匹配当前受限内存缓存中的已加载消息，再继续搜索远端完整历史。Rocket.Chat 未启用全局搜索时，逐会话回退按最近活跃顺序、每两间一批返回进度；没有引入全量持久化消息索引。

## Decisions

- 保留完整历史搜索范围和两路并发上限，避免为了缩短总时长放大 Rocket.Chat 服务端压力。
- 搜索顺序按最近会话优先，但缓存作用域继续使用稳定排序的会话 ID，避免新消息改变会话顺序后造成缓存失效。
- 本机即时搜索覆盖消息正文、文件名和附件文本；结果与远端数据按消息 ID 去重，只保留最近 20 条。
- 本机即时搜索沿用文件索引的房间访问判断，避免已退出或已删除的私有会话通过内存缓存重新暴露。

## Deviations

- 没有新增 SQLite/IndexedDB 全文索引。现阶段受限内存消息扫描 10,000 条约 6.9 ms，持久化全量消息会增加账号隔离、加密、淘汰和离群权限处理成本。

## Surprises

- 原界面把联系人检索和完整历史消息检索合并成同一个“补全远端结果”状态，快路径完成后仍被慢路径占住。
- 逐会话回退原先按房间 ID 排序，用户最近使用的会话不一定先返回。

## Questions for review

- 无。

---

# Implementation notes — GitHub Issues #51 与 #54

## Shipped vs planned

#51 清除普通打开会话时遗留的消息定位，避免列表贴底后又被旧高亮拉回。#54 在现有 ADO 查询结果中按 `System.Parent` 展示父子层级，并支持逐级折叠；未扩大查询范围或增加额外请求。

## Decisions

- 工作项父子关系只在当前结果集内建立；父项不在结果中时，子项作为根显示，保持“我的工作项”和已保存查询的原始语义。
- 默认展开全部层级；筛选和搜索时保留命中项的祖先路径，并临时忽略折叠状态，避免结果被隐藏。
- 直连和 ado-bridge 统一请求 `System.Parent`，复用现有批量详情请求，不增加新接口。

## Deviations

- 无。

## Surprises

- 会话回弹并非贴底时序本身失效，而是三秒内遗留的 `highlightMid` 在贴底后再次触发 `scrollIntoView`。
- 已保存的树查询可能在 `workItemRelations` 中重复出现同一目标工作项；读取详情前按 ID 去重，避免重复行。

## Questions for review

- 无。

---

# Implementation notes — GitHub Issue #48

## Shipped vs planned

修复消息多选、发送换行键、图片引用、隐藏会话恢复入口和删除文案五项反馈。未扩大到消息权限、会话归档或通知模型。

## Decisions

- 多选态使用独立可点击的勾选按钮，点击消息正文仍可切换选择；批量删除只处理自己的消息，并逐条等待服务端完成，避免并发回写旧列表。
- 默认发送方式保持 Enter 发送，但显式处理 Alt+Enter，在当前光标位置插入换行；Ctrl+Enter 发送模式继续可配置。
- 引用图片同时兼容本地乐观附件和 Rocket.Chat 服务端展开后的嵌套附件结构。
- 隐藏会话使用 Rocket.Chat 原生 close/open 接口，单独放在“隐藏”过滤分组，不复制房间或订阅数据。
- 消息菜单统一使用“删除”，移除基于两分钟窗口切换为“撤回”和回填输入框的隐含行为。

## Deviations

- 无。

## Surprises

- Windows Chromium 不会可靠地把 Alt+Enter 当作 textarea 默认换行，必须由输入框显式插入。
- Rocket.Chat 展开的图片引用把原图片放在引用附件的嵌套 `attachments` 中，而不是顶层 `image_url`。

## Questions for review

- #41 仍缺少出现“私密”的完整 Windows 通知截图，本版不猜测修改通知内容。

---

# Implementation notes — 普通员工首次上手

Plan: 当前任务对话中的《第一项：普通员工首次上手》

## Shipped vs planned

已交付 Rocket.Chat 登录预检、可跳过的 Azure DevOps 第二步，以及按服务器和账号隔离的首用清单。通知授权改为用户主动触发，工作台未配置时直接进入连接设置。既有 ADO 配置会跳过第二步，未新增服务端接口或依赖。

## Decisions

- 首次引导状态按 Rocket.Chat 服务器和用户 ID 组合隔离，不复用账号数据归档机制。
- 已有有效 ADO 配置的用户直接视为第二步已完成，避免升级后强制重复配置。
- 首用清单只在会话创建、消息服务端确认和通知实际授权三个成功点写入完成状态。
- Web 首次引导默认选择 ado-bridge；Windows 桌面端默认直连并优先尝试集成认证。
- 登录页始终使用中性“连接 Rocket.Chat”文案；只有登录后读取到当前服务器和账号的待处理状态，才显示首次设置，避免普通重新登录被误判为首次使用。

## Deviations

- ADO 连接成功后直接进入主界面，不额外停留在成功确认页；失败信息留在当前步骤供修改和重试。

## Surprises

- `SettingsPage` 已经包含完整 ADO 探测 UI，但连接编排仍在页面内部；首次引导直接复用底层 `probeAdo` / `directGetIdentity`，不复制探测算法。
- 真实 smoke 首次运行时本地 `admin` 密码与仓库声明的开发凭据漂移；恢复 Meteor 的 SHA-256 后 bcrypt 哈希后，50 项全部通过。

## Questions for review

- 无。

---

# Implementation notes — 全局消息搜索兼容

## Shipped vs planned

快捷搜索会先读取 Rocket.Chat 当前消息搜索提供器。服务器已启用全局搜索时按官方参数请求全部会话；未启用或接口不可用时，自动按最近会话逐个搜索，不再把合法空响应直接显示为“没有相关消息”。

## Decisions

- 全局搜索开启时继续把空结果视为最终结果，避免无意义的逐房间请求。
- 回退搜索并发固定为 2，全部订阅会话（包括隐藏会话）都会参与搜索；每批合并后只保留最新 20 条候选，避免结果集随会话数量线性占用内存。
- 成功结果按服务器、账号、会话范围和关键词缓存 30 秒，最多保留最近 20 个查询；错误和已经过期的查询不写缓存。
- 第三方搜索提供器未声明默认全局开关时继续优先使用其全局搜索能力。

## Deviations

- 无。

## Verification limits

- 本地 Rocket.Chat 已验证全局搜索和逐房间回退对关键词“我”返回相同消息；未覆盖所有第三方搜索提供器。

## Questions for review

- 无。

---

# Implementation notes — 会话打开定位最新消息（Issue #51）

## Shipped vs planned

打开新会话、切回已缓存会话或重复点击当前会话时，消息列表会立即贴底，并在下一帧布局稳定后再次确认位置。消息内容和滚动视口的尺寸变化都会触发贴底补偿。

## Decisions

- 保留现有向上翻页锚点和用户主动浏览历史时不自动拉回的行为。
- 不引入消息列表虚拟化或新的滚动库，只补齐首次布局和视口尺寸变化两个时序边界。
- 延迟贴底带房间校验，快速切换会话时旧房间的下一帧任务不能影响新房间。

## Deviations

- 无。

## Verification limits

- Windows 浏览器自动化工具的持久会话在本机连续调用时会丢失页面，未完成自动化点击录屏；已用结构回归覆盖下一帧复核与双 ResizeObserver，并通过完整构建和真实 Rocket.Chat smoke。

## Questions for review

- 无。

---

# Implementation notes — 长时间运行内存边界

## Shipped vs planned

为聊天房间级缓存和 ADO 悬停查询缓存增加明确上限。聊天完整保留当前会话与最近 8 个非活跃会话，更早房间仅保留最近 60 条消息并释放成员、历史加载状态、输入状态、回执和角色缓存；ADO 工作项、PR、构建缓存改为 60 秒 TTL、最多 300 条的 LRU。

## Decisions

- 会话保留窗口采用“当前 + 最近 8 个非活跃会话”，与首次历史页 50 条和后台消息现有 60 条边界配合，不增加第三套消息数量阈值。
- 被淘汰房间保留最近 60 条消息用于会话预览和实时消息衔接，但清除 `historyLoaded`，再次进入时重新拉取服务端首屏。
- 重新登录或切换服务器时重置房间保留顺序并递增会话代次；旧会话的历史、角色和回执响应即使房间 ID 相同也不能写入新账号状态。
- ADO 两类缓存各保留最多 300 条；缓存命中刷新最近使用顺序，写入时同时清理过期项。

## Deviations

- 原计划只删除已有房间缓存；检查异步路径后补充了迟到历史、角色和回执响应保护。否则用户快速切换会话时，已淘汰房间可能被异步响应重新写回，实际无法形成稳定上限。涉及 `apps/web/src/stores/chat.ts` 的 `openRoom`、`refreshReceipts` 和 `loadRoomRoles`。

## Surprises

- 成员请求已有版本失效机制，可以安全阻止淘汰后的旧成员快照回写；历史、角色和回执此前没有同类保护，需要以房间是否仍在保留窗口内作为落库条件。

## Verification limits

- 自动化覆盖保留顺序、跨账号迟到响应隔离、消息尾部压缩、房间缓存删除、ADO TTL、LRU 和 `null` 缓存语义。真实桌面端长期内存趋势仍需在安装版、已登录账号和代表性会话数据下运行 `pnpm measure:memory:trend`。

## Questions for review

- 无。

---

# Implementation notes — GitHub Issue #49

## Shipped vs planned

桌面端头像与聊天图片改用独立的有界 Blob 缓存；头像组件只在进入视口前 200px 范围后发起认证图片请求，并始终保留固定尺寸的文字头像占位。再次进入消息页时，常用头像不会再被聊天图片或离屏通讯录头像批量挤出缓存。

## Decisions

- 头像缓存上限为 256，聊天图片缓存保持 128；两者仍按 Rocket.Chat 服务器、用户和路径隔离。
- 延迟加载放在统一 `Avatar` 组件，并由一个共享 `IntersectionObserver` 管理，而不是每个头像创建观察器；通讯录、成员面板、搜索结果都不会为离屏头像立即请求。
- 加载前保持固定宽高的文字头像，不使用空白或会改变行高的骨架，避免用户看到列表逐行“展开”。

## Deviations

- 无。

## Surprises

- 通讯录虽然使用 `content-visibility:auto`，但所有 React 组件及 effect 仍会挂载，因此它只能减少布局和绘制成本，不能阻止最多 5000 个头像请求。

## Verification limits

- 自动化覆盖头像/内容缓存隔离、容量收敛与视口触发逻辑；真实 Windows 安装版仍需手工验证“消息 → 通讯录 → 消息”切换时头像是否立即复用。

## Questions for review

- 无。

---

# Implementation notes — Issues #44–#47 与长期运行性能

## Shipped vs planned

消息多选现在直接提供复制、转发和 Markdown 导出；默认逐条转发保留原生图片/文件，合并转发不包含原发送人。任务栏和托盘闪烁可独立关闭。全局搜索的联系人/频道结果置于最上方。性能侧把头像 objectURL 缓存改为有界回收，并把房间级实时订阅收敛到当前活动房间。

## Decisions

- 复制、导出和合并转发共用按时间排序、去发送人身份的内容模型，保留 Markdown 文本、图片地址、文件名和附件字段。
- 系统通知外观继续交给 Windows 管理；网页内仿企业微信弹窗在应用最小化或隐藏时不可见，不作为系统通知替代品。
- 逐条转发是多选默认操作；合并转发保留为次操作，因为合成附件卡片无法完整复刻所有 Rocket.Chat 富消息类型。
- objectURL 缓存上限为 128，只回收引用数为零的最旧项；全部仍在使用时允许短暂超过上限，释放后再收敛。
- `__my_messages__` 继续覆盖所有会话的新消息；房间级消息删除、输入状态和活动事件只订阅当前房间，切换时退订上一房间。
- 全局搜索只调整“全部”结果的展示顺序；各分类页签位置保持不变，避免扩大 #47 的改动范围。

## Deviations

- Windows 下浏览器 QA 启动器未找到源码入口，改为显式启动随包提供的 `dist/server-node.mjs`；已实际验证多选工具栏、转发对话框、Esc 退出和通知开关布局。

## Surprises

- Rocket.Chat 服务端能够正确接受现有逐条与合并附件结构；#45 的主要风险在默认交互和合成内容语义，而不是服务端 API。
- 多选栏一直显示“Esc 取消”，但此前没有注册 Esc 处理器。
- 房间流订阅此前只增不减，切换过的每个房间都会永久保留三条订阅。

## Questions for review

- 如果仍要求完全自绘的企业微信式桌面弹窗，需要另行定义多显示器定位、勿扰时段、弹窗队列和锁屏隐私行为；这不应与 Windows 系统通知同时实现。

---

# Implementation notes — GitHub Issues #36–#39

## Decisions

- #36 的界面字段实际是 ADO 项目；最近选择按 Rocket.Chat 账号隔离，并在同一 ADO 连接内优先恢复。Issue 要求的 Feature/User Story/开发与测试 Task 模板已存在，不重复增加。
- #39 在直连请求源头把“我提的”限制为 active，避免下载后再过滤已完成 PR；bridge 原本就只请求 active。
- #37 只展示 ADO 返回的 `isRequired` / `isContainer` 和 vote，不从名称猜测必审组或策略要求。
- #38 同时统计 RocketX 及其 WebView2 子进程的工作集和私有内存，避免只测壳进程或把共享页重复计入后直接下结论。

## Deviations

- #21 缺少失败请求 URL 和响应体，本轮不猜测 404 根因，也不改认证或 API 路径。

## Surprises

- #36 描述的层级模板与现有 `Feature 全套` 完全一致，缺口只是项目选择未持久化。
- 直连“我提的 PR”仍显式请求全部状态，而 bridge 已经只取 active，两个模式行为不一致。
- Windows release 客户端在已登录并连接状态启动 10 秒后共 7 个进程，合计工作集 476.5 MB、私有内存 271.8 MB；这是当前机器的首个基线，不是跨机器的产品阈值。
- 30 分钟正式趋势共 31 个样本：Private Bytes 从 276.9 MB 降至 274.9 MB，峰值 294.9 MB，净增长 -2.0 MB；通过 350 MB 峰值与 50 MB 增长门槛。

## Questions for review

- #38 以 Private Bytes 作为 Windows 桌面端主要验收指标，Working Set 只记录趋势（共享页会被多个进程重复统计）。`pnpm measure:memory:trend` 连续采样 30 分钟：峰值不得超过 350 MB，末次相对首次增长不得超过 50 MB，并输出 `memory-trend.csv`。阈值基于同机、同账号、已登录主界面约 10 秒后的 271.8 MB 基线，保留约 29% 峰值余量；若业务场景或 WebView2 版本变化，应先重测基线再调整阈值，不以放宽阈值代替定位回归。

---

# Implementation notes — 日常高频 IM 易用性（2.1 + 2.3）

## Shipped vs planned

已交付共享模块顺序、按当前可见列表切换会话、搜索结果切回消息模块、连续处理未读、可调会话列表宽度、可收起分组栏和快捷键帮助。2.2 富草稿迁移按决定未实施。

## Decisions

- 会话列表宽度限制为 220–480px，拖动后按服务器和账号保存，双击分隔线恢复 280px。
- 窄窗口只约束实际显示宽度并临时收起分组栏，不覆盖用户在宽窗口保存的布局。
- 当前未读会话读完后暂留在未读列表；打开下一条未读时替换暂留项，避免列表在阅读过程中跳动。
- 会话快捷键复用列表的过滤、分组、折叠与排序计算，不再另建一套排序规则。

## Deviations

- “下一条未读”同时提供聊天标题栏按钮和 `Ctrl+Shift+↓`，没有新增遮罩式引导。

## Surprises

- 引导状态的存储键已包含服务器，但内存中的 hydrate 去重此前只比较用户 ID；本次补齐服务器比较，避免同 ID 用户切服后沿用旧状态。布局状态采用同一隔离方式。

## Questions for review

- 无。

---

# Implementation notes — Windows 全局指令中心（2.4）

## Shipped vs planned

已交付：Windows 桌面端使用系统全局快捷键唤起未读优先的统一指令中心；Web 只保留原有应用内搜索。设置页支持启停、三个预设组合和注册冲突提示。

## Decisions

- 使用官方 Tauri 2 `global-shortcut` 插件，不自建 Win32 消息循环。
- 默认 `Ctrl+Alt+K`，设置页提供三个预设组合和关闭开关；首轮不支持任意按键录制。
- 空输入优先显示未读会话；没有未读时退回最近会话，避免唤起空面板。
- 配置是设备级本地状态，不按 Rocket.Chat 服务器或账号隔离。

## Deviations

- 桌面 Release `--no-bundle` 已完成 Web 构建并进入 Rust LTO 链接，但用户切换到下一项后停止等待；以 `cargo check` 和真实 `tauri dev` 验收作为本轮桌面证据。

## Surprises

- 现有托盘代码已经完整封装显示、取消最小化和聚焦，新增命令只需复用 `show_main()`。

## Questions for review

- 无。

---

# Implementation notes — 统一搜索（3.1）

## Shipped vs planned

已在现有全局指令中心增加“工作”范围，统一搜索本机待办、日历事件和当前 ADO 连接已加载的工作项。待办可跳回来源消息，日程定位到对应日期的日视图，工作项进入工作台并打开 ADO 原项。

## Decisions

- 工作数据搜索只读取现有 store，不在用户输入时新增网络请求。
- 标题前缀、标题包含、详情包含依次降权，最多显示 20 条结果。
- 继续复用 `Ctrl/Cmd+K` 和 Windows 全局快捷键入口，不新增第二套搜索页面。

## Deferred

- Rocket.Chat 目前仅封装单房间 `channels.files` / `groups.files` / `im.files`。全局文件搜索若逐房间扇出，会随会话数放大请求，因此留到后续设计服务端索引或有界缓存方案。
- 高级筛选、结果分组总览和语义搜索不在本切片内。

## Questions for review

- 无。

---

# Implementation notes — 统一搜索总览（3.2）

## Shipped vs planned

已将“全部”设为普通搜索和 Windows 全局指令中心的默认范围。输入关键词后按会话、消息、联系人/频道、工作分组预览，每组最多三条，并可查看该类型的当前全部结果；空输入仍只显示未读或最近会话。

## Decisions

- “全部”只组合现有四类结果和跳转动作，不建立第二套搜索状态或请求。
- 筛选标签在远端搜索完成后显示当前结果数量，避免加载过程中的数字跳动。
- 键盘上下键与 Enter 严格按总览的视觉顺序移动。

## Deviations

- 无。

## Verification limits

- 没有产品视觉稿或旧版“全部”页可作为截图参考，无法执行基于参考图的 visual-verdict 评分。
- Windows 官方界面控制入口本轮只返回空的非错误结果，未取得自动化截图；以类型检查、回归测试和生产构建覆盖功能正确性。

## Questions for review

- 无。

---

# Implementation notes — 有界文件搜索（3.3）

## Shipped vs planned

已增加按服务器和用户隔离的本机文件元数据索引，以及统一搜索中的“文件”范围。打开会话文件面板并成功加载后，最多索引最近 20 个房间、每房间 50 个文件；点击搜索结果会重新进入房间、刷新文件列表并定位目标文件。

## Decisions

- 只缓存文件 ID、名称、类型、大小、上传时间和上传者，不缓存文件内容、下载路径、认证信息。
- 搜索期间不发起任何文件 API 请求；文件权限和存在性在点击后通过房间及文件面板请求重新验证。
- 已离开的私有房间会从搜索结果中过滤，公开频道仍允许通过现有加入流程打开。
- 界面明确显示索引覆盖的房间数量，不将本机缓存描述成服务器全量搜索。

## Deviations

- 无。

## Verification limits

- 没有文件搜索视觉稿可供 visual-verdict 对照，未生成主观截图评分。

## Questions for review

- 无。

---

# Implementation notes — 搜索结果筛选（3.4）

## Shipped vs planned

已在统一搜索中增加可展开筛选栏。发送人和时间范围作用于当前命中的消息与文件，文件类型仅作用于文件；总览、分类计数、键盘导航和空状态统一使用筛选后的结果。

## Decisions

- 筛选是纯客户端后处理，不改变现有 Rocket.Chat 搜索请求。
- 界面明确说明筛选不会扩大服务器搜索范围；该版本当时消息搜索最多 20 条，现已由顶部“消息搜索无限滚动”改造取代；文件索引搜索仍最多 20 条。
- 时间范围提供不限、近 7 天、近 30 天、近一年；缺少时间戳的结果在启用时间筛选后排除。
- 文件类型同时识别 MIME 和常见扩展名，分为图片、文档、压缩包、其他。

## Deviations

- 无。

## Verification limits

- 没有高级筛选视觉稿可供 visual-verdict 对照，未生成主观截图评分。

## Questions for review

- 无。

---

# Implementation notes — 桌面端开机自启（4.1）

## Shipped vs planned

已接入 Tauri 官方 autostart 插件。桌面端设置页可读取操作系统中的真实注册状态，并显式开启或关闭开机自启；Web 端保持可用且不会尝试修改系统设置。

## Decisions

- 默认保持关闭，不在升级或登录时替用户开启。
- 由官方插件管理各平台的系统启动项，不直接写 Windows 注册表。
- 每次切换后重新读取系统状态，只有实际状态与用户选择一致才提示成功。
- 本轮保持正常显示窗口的启动行为；静默驻留和单实例另行设计，避免用户登录系统后找不到应用。

## Deviations

- 无。

## Verification limits

- 自动化测试不切换开发机的真实系统启动项，避免留下机器级副作用；以插件权限、Rust 编译、Web 降级回归和生产构建验证集成边界。
- 没有桌面设置页视觉稿可供 visual-verdict 对照，界面复用现有 Row 与 Toggle 组件保持一致。

## Questions for review

- 无。

---

# Implementation notes — 桌面端单实例（4.2）

## Shipped vs planned

已接入 Tauri 官方 single-instance 插件。再次启动 RocketX 时，新进程立即退出，已有进程的主窗口会显示、取消最小化并获得焦点。

## Decisions

- single-instance 作为第一个 Tauri 插件注册，遵循官方插件的初始化顺序要求。
- 复用托盘与全局快捷键已经使用的 `show_main()`，避免出现三套不同的窗口恢复行为。
- 当前忽略第二实例传入的参数和工作目录；通知深链或协议链接落地时再定义参数契约。
- 单实例属于桌面可靠性约束，不增加允许用户关闭的设置项。

## Deviations

- 无。

## Surprises

- 无。

## Questions for review

- 无。

---

# Implementation notes — Windows 通知点击跳转（4.3）

## Shipped vs planned

Windows 消息通知现在保留原生通知句柄；用户点击通知正文后，RocketX 会显示并聚焦主窗口、切回消息模块并定位到对应消息。Web 继续使用浏览器 `Notification.onclick`，其他桌面平台保持原有通知行为。

## Decisions

- 官方 Tauri notification 的 Actions API 仅支持移动端；Windows 改为直接复用插件已依赖的 `notify-rust` 后端，不伪用无效的 `onAction()`。
- 通知只携带当前账号内的房间 ID 和消息 ID，不携带服务器地址、令牌、消息正文以外的认证数据。
- 页面端在已登录且聊天初始化完成后才接受导航事件，并再次校验房间 ID 和消息 ID。
- 点击关闭或通知自然过期不触发跳转，只有点击通知正文才执行。

## Deviations

- Windows 的通知发送从官方插件的无句柄封装下沉到同一底层 `notify-rust`，因为官方桌面封装会丢弃响应句柄，无法观察正文点击。

## Surprises

- `@tauri-apps/plugin-notification` 暴露了 `onAction()` 类型，但官方平台说明和 Rust 实现都表明桌面端没有注册该监听器；仅按 TypeScript API 推断会得到一个永远不触发的实现。

## Verification limits

- 当前官方 Windows 界面控制入口返回空的非错误结果，无法自动点击系统通知；已验证响应分支、事件载荷、导航校验、Rust/TypeScript 编译与完整桌面链接，但最终通知中心点击仍需安装版手工验收。

## Questions for review

- 无。

---

# Implementation notes — M11 开源发布与应用生态 v0

Plan: [`m11-implementation-plan.md`](m11-implementation-plan.md)

## Shipped vs planned

SDK、CLI、三个正式样板、固定版本 Docker 栈与双语开源文档已按计划落地，manifest 契约只有
SDK 一份。clean-room 应用生态与三服务栈、完整代码门禁和 Windows Release 均已通过；三平台
安装包交给标签工作流最终验证。M11 实现已通过 PR #72 合并，但蓝图的外部 G3/G4 真人计时和 README
真实截图/GIF 尚未取得，因此不得把 v1.0.0 标记为正式发布。

## Decisions

- manifest 契约以 `@rcx/app-sdk` 为单一事实源，Web 内核与 CLI 只消费，不复制白名单。
- `create-rcx-app` 单包暴露 `create-rcx-app` 与 `rcx-app` 两个命令；开发预览不放宽宿主 iframe CSP。
- Web 的 `manifest.ts`/`types.ts` 使用指向 SDK `src` 的薄重导出，因为 Vite 6 不读取 TypeScript
  `paths`，而 fresh clone 尚无发布用 `dist`；这只改变开发期解析路径，契约实现仍只有 SDK 一份。
- 标签合同要求严格 SemVer、最新 `main`、全仓版本一致、已定稿 CHANGELOG、真实 PNG/GIF 和两位
  不同外部开发者证据；桌面工作流只准备草稿，npm 与 GitHub Release 分别显式批准。

## Deviations

- 开发预览使用回环静态服务与 mock Bridge，而不是在 RocketX 沙箱内部热重载；这样不新增
  localhost 信任边界，也不放宽宿主 CSP。
- npm 包已通过真实 tarball 与临时项目安装验证，但本机 `npm whoami` 返回 `ENEEDAUTH`；在
  registry 账号和 `@rcx` scope 权限确认前不执行公开发布。
- 视觉素材优先尝试正式浏览器控制通道；gstack 后台进程与应用内浏览器初始化均在本机运行时失败，
  因此保留真实人工录制门禁，不用 mock 截图代替。

## Surprises

- Windows 从 Node 启动 `.cmd` 时，`cmd /s` 和对所有参数统一加引号会把引号传给 pnpm；
  clean-room 启动器改为只引用确实需要引用的参数。
- Codex 0.144.4 协议生成树有 671 个文件；旧树必须整体重新生成，不能只更新客户端版本常量。
- 原桌面工作流会在标签构建结束后立即把草稿转正式，且重跑会把旧 `SHA256SUMS.txt` 自身写入新哈希；
  发布加固把草稿准备和公开发布拆开，并在资产目录内生成可直接 `sha256sum -c` 的文件名。

## Questions for review

- npm registry 名称当前未占用，但本机账号是否拥有 `@rcx` scope 必须在发布动作前验证。
- 蓝图要求的两位外部开发者 G3/G4 真人计时不能由自动 clean-room 代理结果替代。
- 英文 README 的真实产品截图与 GIF 演示仍需从可用的 UI 自动化或人工录制流程取得。
