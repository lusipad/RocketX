# RocketX 质量审查清单

> 日期:2026-07-15 · 基于 v0.12.1
> 来源:4 轮并行代码审查(状态/实时流、消息渲染/输入、本地持久化、功能模块)+ GitHub 23 个 Issue + 实机走查
> 基线:typecheck ✓、test:pure 219/219 ✓、test:regression 46/46 ✓、smoke 50/50 ✓(打真实 RC)——但这些测不到渲染层,以下多数问题它们全绿也照样存在
> **当前候选基线（2026-07-21，v0.25.8 待发布）：协议生成物 671 个一致、typecheck 通过、test:pure 219/219、test:regression 469/469、test:ui 30/30、Rocket.Chat 8.6.1 冒烟 53/53、会话分类 5/5、应用生态 clean-room 通过、插件发布包与 Web 生产构建通过、Rust 41/41（另 4 项显式集成测试在标准门禁中保持 ignored）**——上两行的日期与数字是 v0.12.1 时点的历史快照，勿据此推导当前状态
> 未修项由 `docs/blueprint.md`(v2)§7 稳定化轨道认领,本清单继续滚动更新

## 修复进度(滚动更新)

**第十三批(v0.13.0 GitHub Issue 收口,已改完):**
- ✅ 消息内 ADO 工作项、PR 与构建链接统一展开详情卡片;失败时保留可点击原链接
- ✅ 创建层级工作项改用项目真实过程层级,兼容 Basic、Scrum、CMMI 与自定义流程
- ✅ 公开讨论未加入也可查看和发言;加入接口、订阅刷新、通知和已读同步按真实成员状态收口
- ✅ 首次打开会话默认滚到最新消息,未读分割线不再改变初始视口
- ✅ 任务栏未读提醒与桌面通知开关解耦;Windows 托盘未读闪烁增加代次保护并可靠复原
- ✅ 专项回归扩至 78 项并接入 CI;真实 ADO Server 创建路径与完整 RC smoke 仍需在可用环境凭据下复核

**第十二批(v0.12.1 全量 QA 返工,已改完):**
- ✅ 快捷搜索将“合法空结果”与“接口不可用”分开处理,限制逐房间回退并发,并丢弃过期搜索响应
- ✅ 快捷搜索恢复中文联系人拼音匹配,服务端结果与本地花名册合并去重
- ✅ 通讯录与成员分页增加人数/页数/无进展保护;同房间并发成员读取合并为单次请求
- ✅ 成员、提及和搜索结果均按当前房间或关键词隔离,旧请求不再跨上下文回写
- ✅ ADO 配置刷新按连接代次隔离,切换连接立即清除旧链接基址;自定义查询按服务器与查询 ID 独立缓存加载和错误状态
- ✅ 自定义 ADO 查询按 RC 账号与 ADO 连接隔离,外部伪装链接无法保存或执行,旧查询迁移不再误删其他服务器数据;邀请成员期间切房也不会把消息发错会话
- ✅ 桌面任务栏角标写入串行化,快速变化时保证最新未读数最终落地
- ✅ 新增 46 项专项回归并接入 CI;真实 RC smoke 50/50、分类 5/5、桌面 UI 与 ADO Server 实机复核通过

**第十一批(v0.12.0 完整测试与发布收口,已改完):**
- ✅ Rocket.Chat 成员、文件和通讯录改为完整分页;通讯录首屏先展示,后台串行拉全,离页即停止
- ✅ 成员邀请/踢人引入按房间版本和待确认增删集合,旧请求与滞后快照不再回滚新成员状态
- ✅ 跨房间转发剥离原房间受保护文件链接;文件跨源重定向不再携带 Rocket.Chat 认证头
- ✅ QuickSwitcher 不再因实时消息反复重启搜索;消息滚动锚点、窄窗口和弹窗关闭边界同步收口
- ✅ ADO Server 2022 的身份、截止日期、工作项类型、PR/构建筛选与错误状态通过真实服务复核
- ⚠️ 完整通讯录在数万用户租户中的本地搜索成本留作后续性能优化,本版不恢复 5000 人截断

**第十批(工作台三处用户实测反馈,已改完):**
- ✅ **「我的工作项」把不是我的也筛出来了** — 上一批为了"团队范围"直接把团队成员的工作项混进同一列表,污染了"我的"。改成范围**分开**:列表加「分配给我 / 我的团队」切换(默认只看我的,无团队项时不显示切换),待处理队列只算 `mine=true`。工作项恒用 `@Me` 宏,不再用账号字符串精确匹配(格式对不上导致"十几个只剩几个")
- ✅ **「我提的 PR」特别少** — 两个原因:①只拉 active,已完成的全看不见;②靠账号字符串匹配脆。改用 connectionData 的**用户 GUID** 让服务端直接过滤:`reviewerId=我`(active)+ `creatorId=我`(全部状态)。PR 带 `rel`(mine/review/both)与 `status`,"我提的" tab 显示已完成/已放弃徽标,已完成的不进待处理队列
- ✅ **构建看不到"我最近发起的"** — 之前只遍历前 5 个项目(用户项目常不在内)。改成**全部项目** + `requestedFor=我的GUID` + queueTime 倒序
- 新增 5 个单元测试(rel 路由 ×3、团队项排除、已完成 PR 排除),共 177 通过
- identity 按 adoBase 缓存,换服务器自动失效

**第九批(自查返工——此前关闭的 issue 里确认的半成品/理解偏差,已改完):**
- ✅ **中文 ADO 状态全面失效**(#11/#17.4 的真根因) — 此前所有状态判断只认英文,中文流程模板(活动/已解决/已关闭)下配色、逾期排除、划线全部失效。收口成 `workItemStateCategory`(中英都认),AdoLists/WorkItemLink/queue/Calendar 四处共用;WIQL 查询同步补中文状态排除(直连+桥接)。**新增 6 个单元测试**
- ✅ #18.6 再点会话不回最新(此前错判"无需修") — 真场景是跳看历史后再点同一会话回不到底部。加 `scrollToLatest`,点已激活会话滚回最新
- ✅ #12 的 B 半(此前只做了 A) — NTLM 用户不填账号时「我提的 PR」永远空。refresh 里账号为空自动 `directGetIdentity` 探测回填
- ✅ #5/#18.1 在线状态初值(此前半成品) — 不打开通讯录就没有状态点。init 时拉 `users.presence` 全量播种
- ✅ #18.4 悬浮延迟(此前自作主张 500ms) — 按报告者要求默认 3 秒,并做成设置项(0.5s/1s/3s,消息设置区,本机存储)
- ✅ #7/#17.1 状态保持补完 — PR「待我评审/我提的」子 tab、构建「只看失败」也提到全局 store
- ✅ #10 PDF **运行时验证补上**(此前只查了构建产物) — seed-pdf 上传→浏览器点预览→canvas 渲染出页面内容,截图留证
- ✅ #15 发送路径实测补上(此前只修了输入路径) — 发送场景 1020 帧采样,scrollTop 单调无方向反转(P1-2 同 id 合并顺带消除了 temp→真实那一跳)
- ⚠️ 已知限制:#6 的 bottom-full 工具栏在「滚到 50 条分页最顶、hover 第一条消息」时顶部会被裁约 8px(按钮仍可点)。边缘场景,未特判
- 🔄 桌面壳(#2/#3/#4)运行时验证进行中(tauri dev 实跑)

**第八批(第一档+第二档 P1/P2 + 日历跳转,已改完):**
- ✅ 日历点 ADO 工作项直接跳转 — CalendarPage 的 `window.open` 换成 `openExternal`(桌面端 window.open 打不开系统浏览器);顺带修 P2-t(今日日程里工作项那个点了没反应的假复选框)
- ✅ P1-14 切在线状态清空状态消息 — applyStatus 只传显式 text,切状态不再发空 message 清掉「开会中」
- ✅ P1-12 日历重复次数填 0 消失 — <1 一律当「不限」;新增回归测试
- ✅ P1-15 会话备注弹窗点任意处切会话 — 弹窗移出会话 button，不再冒泡触发 openRoom+标已读
- ✅ P1-6 偏好未加载 Enter 发半句 — prefs 未 loaded 时按「Ctrl+Enter 才发」保守规则(主输入框 + 话题面板)
- ✅ P1-13 周视图全天日程错位 — 全天区从各列内部抽成跨列独立一行,各列时间轴从同一 Y 起、与刻度对齐。**实机截图验证**
- ✅ P1-11 成员列表失败显示「暂无成员」 — loadMembers 把失败原因记到 store 的 memberErrors,面板区分「失败」与「真没人」
- ✅ P2-f 提及补全 Enter 劫持输入法 — 输入法合成中补全面板一律不拦按键
- ✅ P2-g 补全插入不进草稿 — insertCommand/Mention/Emoji + @/斜杠按钮都补 persistDraft
- ✅ P2-d 时间戳当 emoji — emoji 短代码加前后边界,10:30:00 不再触发裂图;新增回归测试
- ✅ P2-b #123. 句号吞进 token — 提及/工作项的 `.`/`-` 只允许在词字符之间;新增回归测试

**第七批(第二波 issue #16/#17/#18 全部,已改完):**
- ✅ #17.4 已解决工作项标逾期 — queue.ts 用 `isWorkItemDone` 跳过已完成项 + CalendarPage 同步不标红。新增单元测试
- ✅ #17.2 PR 只显示一部分 — 直连/桥接都改成 `$skip` 翻页拉全(单页 100 上限)。**需 ADO 环境验**
- ✅ #17.3 构建显示古老的 — 直连/桥接加 `queryOrder=queueTimeDescending` 拿最近触发的。**需 ADO 环境验**
- ✅ #18.7 通讯录只显示前 100 — searchUsers 加 offset,ContactsPage 首屏先展示并在后台串行翻页拉全,离页停止继续请求
- ✅ #18.3 搜索中文搜不到+不高亮 — searchMessages 自动把 CJK 查询包成正则(绕开服务端未开 RegExp);新增 `lib/highlight.tsx` 共享高亮,QuickSwitcher 全局搜索结果也高亮
- ✅ #18.5 备注名 — UserCard/MembersPanel 补读备注(此前只有会话名生效);新增"备注名/备注名(原名)"显示格式配置(本地存,设置页可切)
- ✅ #18.6 点消息不跳最新 — 实机验证行为已正确(无未读→最新,有未读→上次读到位置),和 #8 是同一件事,已被 #8 修复覆盖,无需改代码
- ✅ #16 多条消息合并转发 — 消息多选态 + forwardMessages(合并/逐条)。合并成一条「聊天记录」卡片(复用 AttachmentCard 堆叠渲染)。**浏览器实测+截图确认:目标会话收到含 3 子条目的合并卡片**
- ✅ #18.2 工作项内联卡片 — `#工作项号` 从「蓝链接+悬停」改为内联紧凑卡片(类型点+#号+标题+状态),仍保留 hover 完整卡+快速评论,拉不到时降级纯链接。**需 ADO 环境验**
- ✅ #15 输入时界面抖动 — 报告者澄清是「输入文字后界面刷新」。定位:Composer 的 autoResize 每次输入都 `height='auto'` 再量一次(且 onChange 的 rAF + useEffect 各跑一遍,每键两次强制回流),中文输入法逐字合成时肉眼可见地抖。改用 CSS `field-sizing:content` 原生自适应高度、JS 仅作旧浏览器回退,并去掉重复调用。**实机验证:输入 15 字后 textarea 的 style 被 JS 写入 0 次(原每键 2 次),且多行自适应仍正常**

**第六批(第二波 issue 中我的责任项,已改完):**
- ✅ #18.4 悬浮条延迟触发 — 操作栏从 CSS `group-hover` 即时改为 JS 延迟(命名常量 `HOVER_DELAY_MS=500`,方便改数值);表情/菜单打开时保持显示。**实机验证:悬停瞬间不出现、700ms 后出现**
- ✅ #18.1 消息页/会话列表在线状态 — 补齐我 #5 的半成品。**重构:userStatus 改按用户名键**(RC 8.6.1 的 DM 房间 id 是普通 id、推不出对端 userId,而用户名是消息/会话列表/成员各处都有的公共字段);openRoom 播种本房间成员状态;消息头像 + 会话列表 DM 头像接入。**实机验证:注入在线后消息头像出 2 点、会话列表 DM 出 1 点**
- ✅ #17.1 工作项筛选切页丢失 — 状态筛选从组件局部 state 提到 `useUI` store;存的值在当前工作项里不存在时回退「全部」免得列表空掉。**typecheck 过(需 ADO 环境看实际)**
- ⏸ #15 发送时窗口抖动 — 多次高频采样 scrollTop 未复现出抖动(单调、无来回跳),**没硬修**,等报告者补充消息类型/抖动形态

**已修复并验证:**
- ✅ P0-1 / #14 markdown 表格死循环 — 段落分支先无条件吃当前行;新增 4 个回归用例(含 #14 原文);实机发 `|`/伪表格/`> |` 不再冻死。**#14 是 P0-1 的用户实例,同一修复覆盖**
- ✅ P0-5 白屏 — `loadTheme`/`saveTheme` 加 try/catch + 新增根 ErrorBoundary(`components/ErrorBoundary.tsx`)
- ✅ P0-6 工作台/日历无限刷新 — WorkbenchPage/CalendarPage 用 triedRef 护栏,失败不再重试
- ✅ #6 悬浮条遮字 — 工具栏从 `-top-4` 改 `bottom-full`,实机量得底边在气泡顶边之上,不盖正文
- ✅ #7 工作台切走不保持 — tab 提到 `useUI` store(dev 环境无 ADO,运行时未验;typecheck 过、构造正确)
- ✅ #8 切会话滚动 — 根因是 ResizeObserver 依赖 `[rid]`,首屏骨架屏时挂不上→带图会话停半空。改依赖 `[rid, historyLoaded]`。实机验证:60 条消息会话打开/切换均正确到底部
- ✅ #9 引用回复 — 根因坐实(脚本证明:前缀 = Site_Url 才展开,不匹配则不展开)。`send()` 改为 `await ensureSiteUrl()`,不再用可能不匹配的 getServerBase 回退。实机发引用→直连服务端确认 message_link 已展开
- ✅ #11 已解决工作项不区分 — 悬停卡片徽标复用 stateStyle 配色 + 已完成标题划线(dev 无 ADO,未运行时验)

**第三批(桌面壳 + ADO + 在线状态,已改完):**
- ✅ #2 拖拽文件不能发送 — Tauri 默认拦截 OS 拖放,webview 收不到文件。`tauri.conf.json` 窗口设 `dragDropEnabled: false`,web 已有的 onDrop 就生效。**cargo check 过;需桌面运行时验证**
- ✅ #3 关闭不最小化到托盘 — main.rs 加系统托盘(菜单:显示/退出,左键点图标显示)+ 拦截 CloseRequested 隐藏窗口。Cargo.toml 加 `tray-icon` feature。**cargo check 过(52s);需桌面运行时验证**
- ✅ #4 系统通知已拒绝 — WebView2 里 Web Notification 常年 denied。加 `tauri-plugin-notification` + 新建 `lib/notify.ts`(Tauri 走插件、浏览器走 Web Notification),chat/MainPage/Settings 全部改走它。**cargo check + typecheck 过;需桌面运行时验证**
- ✅ #5 在线状态 — 订阅 `stream-notify-logged`/`user-status` + userStatus map + directory 播种初值 + Avatar 状态点。接入通讯录、成员面板。**浏览器运行时验证:状态点渲染、store 追踪正常**
- ✅ #10 PDF 解析失败 — 桌面端 module worker 从 Tauri asset 协议加载,MIME 被拒。改用 `?worker&inline` + workerPort,worker 走内联 blob。**build 验证:产物确为内联 blob worker(new Blob→createObjectURL);需桌面运行时最终确认**
- ✅ #12 我提的 PR 没记录 — account 与 PR 身份格式(DOMAIN\ / 邮箱 / 显示名)对不上,精确匹配全空。matchUser 加身份归一化。**新增 4 个纯函数用例验证**
- ✅ #13 ADO 链接显示标题 — 粘贴工作项 URL(`/_workitems/edit/123`)自动 unfurl,复用 WorkItemLink。**typecheck + build 过;需 ADO 环境验证**

**13 个 GitHub Issue 全部处理完毕。** 验证级别汇总:
- 浏览器运行时验证:#6 #8 #9 #5
- 单元/构建/编译验证(需最终真机确认):#2 #3 #4 #7 #10 #11 #12 #13 #14

**第四批(认证与实时健壮性,已改完):**
- ✅ P0-2 断线丢消息 — chat.ts 重连成功(reconnecting→connected)后 `backfillAfterReconnect`:刷新 subscriptions/rooms + 补拉当前房间 getHistory 并 upsert。**typecheck + smoke 46/46;需网络故障注入做最终运行时验证**
- ✅ P0-3 login 失败静默假死 — realtime.ts 重连时把 `setStatus('connected')` 移到 login 成功之后;login 失败不再空 catch,而是停止重连 + 触发 `onAuthFailure`。**smoke 46/46 覆盖 connect+login+subscribe+receive**
- ✅ P1-9 多标签不同步 — auth.ts 加 storage 事件监听:其他标签登出→本标签登出,换账号→重载
- ✅ P1-10 token 失效无处理 — rest.ts 加 `onAuthError`(带 token 的请求收 401、排除 login),client 注册 handler,auth.ts `handleAuthLost` 登出回登录页。**浏览器运行时验证:改坏 token 触发调用→掉登录页+显示「登录已失效」**
- ✅ P2-j 无心跳 — realtime.ts 心跳看门狗:track lastActivityAt,20s 检查、45s 无活动强制重连

批次 2 验证级别:realtime.ts 核心改动由 smoke 覆盖(46/46);P1-10 浏览器运行时验证;P0-2 断线补消息需网络故障注入最终确认。

**第五批(审查发现的高危项,已改完):**
- ✅ P1-2 重复消息/重发第二条 — 客户端生成消息 `_id` 并随请求提交(实测 RC 8.6.1 接受、同 id 幂等),乐观消息/WS 回声/REST 响应同 id 天然合并;catch 只对仍 pending 的标失败(回声抢先确认就不误标);重发沿用同 id。**浏览器实测:发一条消息列表里只有 1 条、id 非 temp、pending=false;smoke 46/46**
- ✅ P0-4 换账号擦数据+泄露 — 新增 `lib/accountScope.ts`,登录后对比 `rcx-owner`,换账号则把裸 key 归档成 `<key>#<旧owner>`、还原新账号归档、再 reload。**浏览器实测:植入 OTHERUSER 待办→admin 登录后裸 key 清空、数据归档可还原、owner 更新**
- ✅ P1-8 附件 title_link XSS — `safeTitleHref` 只放行相对路径与 http(s),`javascript:`/`data:` 等不当链接。**typecheck + 审查确认(markdown 渲染器本就只认 https?://,这是唯一缺口)**

**下方明细保留问题发现时的现象与修法:**
- 当前状态以顶部滚动更新为准;只有未列入上方已修复批次的 P1/P2 项仍待处理

## 怎么读这份文档

- **P0** = 数据丢失 / 白屏 / 崩溃 / 安全。用户无法自救,且多数是"界面看起来正常"的静默故障。
- **P1** = 功能真的坏了,用户能明确感知。
- **P2** = 体验瑕疵、边界错误。
- 每条尽量给了**具体触发步骤**和**文件:行**。带 `#N` 的是对应的 GitHub Issue。

---

## 一、P0 — 必须最先修

### P0-1 · 一条消息永久冻死会话(markdown 表格死循环)
- **文件**:`apps/web/src/lib/markdown.tsx:333-342`(`isBlockStart`)vs `:200-243`(表格分支)、`:312-321`(段落分支)
- **现象**:发一条内容为 `|` 的消息,或没写分隔行的表格(`| 姓名 |` 换行 `| 张三 |`),**整页立刻冻死,内存暴涨**。消息已落库,重开该会话**再次冻死**,只能去服务端删消息才能恢复。同样影响 `.md` 文件预览和引用块递归(`> | a`)。
- **根因**:`isBlockStart` 把 `/^\s*\|/`(任何 `|` 开头行)判为块起始,但表格分支要求下一行是分隔行 `| --- |`。不构成表格时,段落分支的 `while (... && !isBlockStart(lines[i]))` 因 `isBlockStart` 恒为真而一次不执行,`i` 不自增,外层 `while` 无限空转。**块起始判定比实际能处理的分支更宽 = 死循环。**
- **已验证**:审查用 Node 复刻控制流,`"|"` / `"| a | b |"` / `"| 姓名 |\n| 张三 |"` 全部 20 万轮不退出;合法表格 `"| a |\n| --- |\n| 1 |"` 正常。
- **修法**:段落 `while` 里对"看起来是块起始但没有对应分支消费"的行要能兜底推进 `i`(比如 `|` 行若不构成表格,就当普通段落行吃掉);或让 `isBlockStart` 的 `|` 判定和表格分支的前置条件对齐。**任何"块起始判定"都必须有分支真正消费它,否则必死循环。**
- **兜底建议**:`renderBlocks` 外层 while 加一个"本轮 `i` 未推进就强制 `i++`"的保险,杜绝这类问题再犯。

### P0-2 · 断线重连后不补消息,断网期间的消息永久丢失
- **文件**:`packages/rc-client/src/realtime.ts:173-190`(重连只重发订阅)、`apps/web/src/stores/chat.ts:432-445`(`onStatus` 只弹 toast)、`chat.ts:533`(`if (!historyLoaded[rid])` 一次性)
- **现象**:断网 30 秒(拔网线/电梯/切 WiFi),期间同事发的消息,重连后**永远不出现**,消息流中间留下静默空洞。切走再切回也没有(`historyLoaded` 是一次性的),**只有 F5 能恢复**。断线期间错过的 `subscriptions-changed`/`rooms-changed` 同样永久丢失 → 未读徽标、会话排序、`lastMessage` 预览全部停在断网前。
- **根因**:RC 的 stream 是纯 live pub/sub(`subscribe` 传 `[key, false]`,服务端不回放),订阅恢复 ≠ 消息恢复。`onStatus` 回调里没有任何补拉。
- **修法**:重连成功后,对当前打开的房间用 `getHistory` 拉断线时间点之后的消息并 upsert;同时重新拉 `getSubscriptions`/`getRooms` 刷新列表。记录"最后收到消息的时间戳"作为补拉起点。

### P0-3 · 重连时 DDP login 失败被空 catch 吞掉 → 界面显示"已连接"但实时流彻底哑火
- **文件**:`packages/rc-client/src/realtime.ts:175-182`(空 catch)、`:210-212`(`nosub` 被 `default:` 忽略)
- **现象**:挂机过夜(token 过期)/管理员吊销会话/服务端重启 → WS 重连 → `login` 被拒 → **空 catch 吞掉** → 状态照样置 `connected`、toast 照说"已重新连接" → 订阅以未认证身份发出,全被 `nosub` 拒绝(而 `nosub` 又被丢弃)→ **界面完全健康,但此后再收不到任何消息/未读/typing**,用户毫无察觉直到手动刷新。
- **根因**:`setStatus('connected')` 在 login 之前就执行;注释承诺的"由上层 REST 层重新登录"**在代码里不存在**(grep 全仓无人监听 DDP login 失败)。
- **修法**:login 成功后再 `setStatus('connected')`;login 失败要走真正的重新登录(用 REST 的 resume)或掉回登录页,不能静默吞。`nosub` 要处理(至少 warn + 触发重登)。
- **关联 P1**:见 [P1-token 失效无全局处理]。

### P0-4 · 换账号会永久擦光上一个账号的分组,并把待办/日历泄露给下一个人
- **文件**:`apps/web/src/stores/folders.ts:171-182`(prune)、`GroupFilter.tsx:119-122`(调用)、`auth.ts:83-93`(logout 不清本地数据)
- **现象**:用户 A 建分组、拖会话 → 退出 → 用户 B 在同机登录 → `GroupFilter` 挂载跑 `prune(B的rid集合)` → A 的 rid 都不在里面 → 分组内容被 filter 成空**并立刻写盘** → A 再登录时分组还在、里面全空、**不可恢复**。同一步骤 B 还能在待办页看到 A 的全部待办(含最多 200 字原消息摘要)、A 的日历、A 的备注名——**共用电脑上是内容泄露**。换服务器(`client.ts:54-57` 只清 `rcx-site-url`)同样触发擦除。
- **根因**:所有本地 key(`rcx-folders`/`rcx-todos`/`rcx-aliases`/`rcx-drafts`/`rcx-calendar`/`rcx-favorites`)都不带 userId/服务器前缀,logout 也不清理。
- **修法**:localStorage key 按 `userId@serverUrl` 命名空间隔离(如 `rcx-folders:u123@host`);或 logout 时清空这些 key。前者更好(切回原账号数据还在)。

### P0-5 · localStorage 被禁用时整页白屏(且全仓没有 ErrorBoundary)
- **文件**:`apps/web/src/lib/theme.ts:6-9`(`loadTheme` 无 try/catch)、`main.tsx:14`(在 `ReactDOM.render` 之前调)
- **现象**:浏览器对该站点选"阻止站点数据",或企业策略/嵌入式 webview 禁用存储 → `loadTheme()` 在渲染前抛 `SecurityError` → `render()` 永远执行不到 → **纯白页,只有控制台一行错**。
- **根因**:全仓 11 处 localStorage 读取,唯独这个启动路径上的没兜 try/catch;且**全仓无任何 ErrorBoundary**(`componentDidCatch`/`getDerivedStateFromError` 零命中),渲染期任何抛错都白屏。
- **修法**:`loadTheme` 包 try/catch;**根组件加一个 ErrorBoundary**(这个价值远超本条,能兜住所有未预期的渲染崩溃,后面 P0-6 那种同步抛错也一起兜了)。

### P0-6 · ADO 连不上时,工作台/日历陷入无限刷新循环
- **文件**:`apps/web/src/pages/WorkbenchPage.tsx:262-264`、`CalendarPage.tsx:349-354`、`stores/workbench.ts:135-196`
- **现象**:配好 ADO → 断 VPN / 关掉 bridge → 打开"工作台"或"日历" → **每秒几十上百次请求**,页面一直转圈卡顿,直到切走模块。
- **根因**:effect 依赖含 `loading`,`refresh()` 失败只置 `error` 不置 `lastRefresh` → `loading: true→false` 又让 `connected && !lastRefresh && !loading` 重新成立 → 再 refresh。且 `refresh` 内无 in-flight 去重。
- **修法**:失败时也置 `lastRefresh`(或单独的"已尝试"标志);effect 依赖里去掉 `loading`;`refresh` 加 in-flight 去重。

---

## 二、P1 — 功能明确坏了

### P1-1 · 引用回复:界面有动画,实际发出的消息里没有引用 · **#9**
- **文件**:`apps/web/src/stores/chat.ts:301-303`(`quoteLinkPrefix`)、`lib/client.ts:91-111`(`ensureSiteUrl`/`siteUrlSync`)
- **现象**:选一条消息引用回复,输入框上方有引用条(动画来自 `localQuoteAttachment` 本地乐观附件),但发出后**真实消息里没有引用**。
- **根因**:引用靠给消息文本加前缀 `[ ](<Site_Url>/<房间路径>?msg=<id>) `,由**服务端**识别展开。服务端只认以真正 `Site_Url` 开头的链接。`siteUrlSync()` 回退链是 `siteUrlCache || getServerBase() || location.origin`——一旦 `ensureSiteUrl()` 没预热成功(init 时机/网络),或用户访问地址 ≠ RC 后台配的 `Site_Url`(桌面端填 IP 但 Site_Url 配 localhost),前缀对不上,服务端不展开。smoke 测不出:它直接打 RC_URL,地址天然一致。
- **待确认**:本机 dev 环境 Site_Url=`http://localhost:3300`,与 `getServerBase()` 一致,理论上应能展开。**需实机验证到底是 `ensureSiteUrl` 没预热、还是 `roomPath` 对某类房间(DM/讨论)拼错、还是 RC 8.6.1 展开行为变化**。建议:发引用后直接查服务端存的消息有无 `attachments[].message_link`。
- **修法**:视实测定。至少要保证发送时 `ensureSiteUrl()` 已 await 完成(而不是用可能未预热的 sync 值);前缀拼接失败时给用户可见提示,而非静默发出无引用的消息。

### P1-2 · 乐观消息与 WS 回声重复显示;超时重试会发出第二/第三条 · **#9 关联**
- **文件**:`apps/web/src/stores/chat.ts:603-658`(send)、`:449-453`(stream 回声)、`:204-212`(upsertMessage 只按 `_id` 去重)
- **现象**:(A)发消息时 WS 回声常比 HTTP 响应先到,窗口期内**同一条消息渲染两遍**(temp + 真实),网络慢时肉眼可见。(B)发送时代理返回 504 但服务端其实已落库 → 真实消息已上屏 + temp 被标红色失败 → 用户看到同句话两条、点"重试" → **发出第三条**。
- **根因**:乐观消息 id 是本地 `temp-xxx`,与服务端分配的 `_id` 永不相等,`upsertMessage` 无法合并。
- **修法**:照 RC 官方客户端——**客户端生成 `_id` 并传给 `chat.sendMessage`**(该字段服务端接受),乐观消息和回声天然同 id、天然合并;重试就是同 id 幂等,不会重复。这一条同时根治重复显示和重试重发。

### P1-3 · 切换会话不滚到最新/上次位置 · **#8**
- **文件**:`apps/web/src/components/MessageList.tsx`(滚动逻辑)、`stores/chat.ts:528-547`(openRoom)
- **现象**:切到某会话,没有默认滚到最新消息(或上次读到的位置)。
- **修法**:openRoom 后滚到底部(或未读分割线);配合 P1-7 的 anchor 残留一起看。

### P1-4 · 切走工作台再回来,页面状态丢失(回到默认子页) · **#7**
- **文件**:`stores/ui.ts`(module 是单一枚举,无子状态)、`WorkbenchPage.tsx`
- **现象**:工作台切到某个子视图 → 切到消息 → 切回工作台 → 回到默认页,而非之前的子页。
- **根因**:模块切换只存 `module` 枚举,不存各模块内部的子状态。
- **修法**:各模块的子页/滚动位置存进 store(或各自 store),切回时恢复。

### P1-5 · 没显示其他人的在线状态 · **#5**
- **现象**:看不到联系人/成员的在线/离线/忙碌状态。
- **根因**:未订阅 `stream-notify-logged` 的 `user-status`,或未在头像上渲染状态点。这是**未实现**,不是坏了。
- **修法**:订阅用户状态流,头像加状态指示点。

### P1-6 · 偏好加载失败时静默跑默认值,Enter 会把半句话发出去
- **文件**:`apps/web/src/stores/prefs.ts:87-104`、`Composer.tsx:40,286-294`
- **现象**:用户设"Ctrl+Enter 发送、Enter 换行" → 重启后 `users.info` 慢/超时/失败 → `sendOnEnter` 静默回落 `'normal'` → 按 Enter 想换行,**半句话发出去**,聊天页无任何提示。首屏到 users.info 返回间也有几百 ms 同样窗口。
- **修法**:prefs 未加载完成前,Composer 禁用发送或用保守策略;加载失败要在聊天页也可感知(不只设置页)。

### P1-7 · loadOlder 返回 0 条时 anchor 残留 → 后续新消息把视口甩回顶部
- **文件**:`MessageList.tsx:62-88`、`stores/chat.ts:580-586`
- **现象**:打开消息数恰为 50 整数倍的会话 → 滚顶触发加载更早 → 返回 0 条 → 滚回底部继续聊 → 来一条新消息 → **视口从底部被甩到历史顶部**。
- **根因**:`loadOlder` 返回空时 `merged` 是同一数组引用,`set` 后引用不变、布局副作用不跑、`anchor.current` 永不清,被下一次任意列表变更消费。
- **修法**:空结果直接 return 不 set;或消费 anchor 后无条件清空。

### P1-8 · 附件卡片 title_link 无协议校验(XSS)
- **文件**:`apps/web/src/components/MessageItem.tsx:266`
- **现象**:attachment 的 `title_link` 为 `javascript:...` 时,React 只 dev 告警、照样渲染,点击在应用源上执行,可窃取 localStorage 里的 authToken。集成/机器人/被入侵的 App 都能通过 `chat.postMessage` 构造这种 attachment。
- **说明**:markdown 渲染器本身干净(全仓无 `dangerouslySetInnerHTML`,链接硬性要求 `https?://`)。唯一缺口就是这个"服务端字段直接当 href"。
- **修法**:href 渲染前校验协议白名单(`http`/`https`/`mailto`),其余一律不作为链接。

### P1-9 · 多标签页认证状态不同步
- **文件**:`auth.ts:83-93`、`client.ts:186-190`(authProvider 每次请求实时读 localStorage)
- **现象**:(A)一个标签退出 → 另一个标签界面不变仍显示已登录,但所有 REST 请求 401,满屏"没有权限"。(B 更糟)一个标签换账号 B 登录 → 另一个标签的请求立刻带 B 的 token,但界面还是 A 的会话 → **在 A 的会话里发消息,以 B 的身份发出**。
- **修法**:监听 `window.addEventListener('storage')`,认证变化时同步内存状态(登出→掉登录页,换账号→重载)。

### P1-10 · token 失效后无全局处理
- **文件**:`auth.ts`(无 401→登出通路)
- **现象**:token 被吊销/过期 → 界面停在已登录、realtime 还在推消息进来,但所有 REST 全 401 → 用户看到消息在动却什么都点不动,以为是网络问题反复重试。
- **修法**:REST 层统一拦截 401 → 掉回登录页(和 P0-3、P1-9 是同一套认证健壮性问题,建议一起做)。

### P1-11 · 成员列表拉取失败显示"暂无成员"(掩盖权限错误)
- **文件**:`MembersPanel.tsx:271-277`、`chat.ts:590-601`(`loadMembers` 内部 `catch{return []}` 吞异常)
- **现象**:无成员查看权限的频道,成员面板显示"暂无成员"而非错误态;面板里写好的错误 UI(第 315-320 行)是死代码。
- **修法**:`loadMembers` 把错误抛出去,让组件区分"空"和"失败"。

### P1-12 · 日历重复次数填 0,日程创建后彻底消失
- **文件**:`CalendarEventDialog.tsx:295-299`(无校验)、`stores/calendar.ts:224`
- **现象**:新建重复日程,"重复次数"填 `0`(理解成"不限")→ 提示创建成功 → 所有视图都找不到,但数据在 localStorage 里。
- **根因**:`"0"` 是 truthy 被存成 `endAfter:0`,`occurrence >= 0 && occurrence >= 0` 对每一天都为真 → 全部不匹配。
- **修法**:`canSave` 校验 `endAfter >= 1`;或把 0 当"不限"处理。

### P1-13 · 周视图有全天日程的列,时间轴整体下移与刻度错位
- **文件**:`TimeGrid.tsx:113-162`、`:287-300`
- **现象**:周三建全天日程(或有待办截止周三)→ 周三列的 09:00 事件画在其他列 09:30 高度上,对不上左侧刻度。
- **根因**:全天区是列内普通块级元素占文档流,把时间轴顶下去,左侧刻度栏无对应偏移(注释说要 sticky 对齐,代码没实现)。
- **附带**:`NowLine` 只在渲染时算一次 top,无定时器,红线长时间不动。
- **修法**:全天区做成绝对定位/独立行,或刻度栏同步偏移。

### P1-14 · 设置里切在线状态会清空服务器上的状态消息
- **文件**:`SettingsPage.tsx:71,89-100`、`rest.ts:198-203`
- **现象**:别处设了状态消息"开会中" → 打开设置点"忙碌" → **状态消息被清空**,输入框全程为空(RcUser 没 statusText 字段也没去拉)。
- **根因**:`applyStatus` 不传 text → 发出 `message:''` → 服务端清空。`?? statusText` 只在 undefined 时兜底,空串是合法值被原样发出。
- **修法**:改状态时不传 message 字段(只改 status);或先拉当前 statusText 回填。

### P1-15 · 会话备注弹窗点任意位置都会切换会话并标已读
- **文件**:`ConversationList.tsx:150`(根节点是 `<button onClick={openRoom}>`)、`:248-260`(AliasDialog 是其子节点)
- **现象**:右键会话 B(有未读)→ 设置备注名 → 在弹窗里点任何地方 → 背后已切到 B 并清掉未读;点"取消"也会切过去。
- **根因**:弹窗内容区无 stopPropagation,click 冒泡到外层会话按钮。且 `<input>/<button>` 嵌在 `<button>` 里是非法 DOM 嵌套(React validateDOMNesting 告警)。
- **修法**:弹窗用 portal 渲染到会话按钮外(参考 `ContextMenu.tsx:65-71` 已处理);或内容区 stopPropagation。

---

## 三、P2 — 体验瑕疵与边界

### 渲染 / markdown
- **P2-a** 链接文字含 `(` → href 截错。`[点这里(重要)](url)` 的 href 变成 `重要)](url)`。`markdown.tsx:47-48`(用了第一个 `(`)。
- **P2-b** `#123.` / `@zhang.` 结尾英文句号被吞进 token → **ADO 工作项链接不生成**、**@我 高亮不出现**。`markdown.tsx:24-25,99`(字符类含 `.`)。中文句号不受影响。
- **P2-c** 自动链接吞掉 ASCII `)`。`see (https://ex.com/x)` 链接变成 `...x)`。`markdown.tsx:14`(排了全角 `）` 没排 ASCII)。
- **P2-d** 时间戳被当 emoji。`10:30:00` 里 `:30:` 触发 `/emoji-custom/30.png` 请求 404 闪裂图。`markdown.tsx:23`(无边界约束)。
- **P2-e** `#fff` / `#404` 被当频道或工作项高亮。`markdown.tsx:25,97-107`(误伤面比预期大)。

### 输入 / Composer
- **P2-f** @ 提及补全 Enter 无 `isComposing` 保护 → 中文输入法回车被劫持插入候选人,文本错乱。`Composer.tsx:276`(斜杠分支 248 行有保护,提及分支忘了)。上下键选字同样被面板抢。
- **P2-g** 按钮/补全插入的文本不进草稿 → 切会话丢失。点表情/补全 `@`/`/` 后切会话再回来,内容没了或回退到旧值。`Composer.tsx:128-195,405-439`(只 onChange 调 persistDraft)。
- **P2-h** ThreadPanel 与 Composer 三处不一致:话题回复无草稿(关面板即丢)、话题里点"回复"引用条跑到主输入框且发送时被丢弃、话题不支持粘贴文件。`ThreadPanel.tsx` vs `Composer.tsx`。
- **P2-i** 首次打开带图会话 ResizeObserver 挂不上 → 图片撑开时不补偿滚动,停半空,第二次进才生效。`MessageList.tsx:127-137`(effect 依赖 `[rid]`,骨架屏时 ref 为 null)。

### 实时 / 状态
- **P2-j** 无心跳超时检测,半开连接静默失联。睡眠唤醒/切热点后 socket 半开,状态停 `connected` 无横幅,收不到消息也无提示。`realtime.ts:169-172`(只被动应答 ping)。
- **P2-k** markReadTimer/receiptTimer 是全局单例,快速切房间时"已读"标到错误房间。`chat.ts:239-266`。改成 `Map<rid,timer>` 或回调里校验 `activeRid===rid`。
- **P2-l** emitTyping 节流游标全局,切房间后 3 秒内不广播"正在输入"。`chat.ts:241,764-766`。
- **P2-m** 提及检测正则未转义用户名,`zhang.san` 会把 `@zhangXsan` 误判为提及。`chat.ts:353-355`。
- **P2-n** scheduleMarkRead 静默吞失败(401/500),未读徽标清不掉且无解释。`chat.ts:256`。
- **P2-o** 成员面板单独打开时,已禁言成员菜单显示成"禁言"(动作路径已兜底,显示路径没兜)。`MembersPanel.tsx:162,239`(未调 refreshRoomInfo)。

### 搜索 / 列表
- **P2-p** QuickSwitcher/SearchPanel 无在途请求作废:清空搜索框后旧结果仍显示;先搜慢词后搜快词,慢词响应后到会覆盖。`QuickSwitcher.tsx:86-114`、`SearchPanel.tsx:21-49`。
- **P2-q** QuickSwitcher 开着时每条新消息重置搜索防抖并重发。`QuickSwitcher.tsx:114`(deps 含 `conversations`)。
- **P2-r** 分组栏"@我"数字是消息条数,点进去列的是会话数(其他计数都是会话数,只这个不一致)。`GroupFilter.tsx:135`。

### 日历 / 工作台
- **P2-s** custom 重复勾"周日"时"重复 N 次"算错次数(周日按数字 0 排到最前,occurrence 顺序颠倒)。`calendar.ts:200-220`。
- **P2-t** 日历右栏"今日日程"里 ADO 工作项被塞了个点了没反应的复选框(上方列表同一工作项没有,两处不一致)。`CalendarPage.tsx:607-617`。
- **P2-u** 收藏夹链接不带协议 → 点开应用内 404(`wiki.corp.com` 变成 `http://host/wiki.corp.com`)。`WorkbenchPage.tsx:110-121,546-551`(无 URL 校验)。
- **P2-v** 日历/收藏弹窗无 Esc/Enter 支持(项目有统一 Dialog 做了,这两个手搓遮罩没用)。`CalendarEventDialog.tsx:114`、`WorkbenchPage.tsx:129`。

### 草稿 / 存储
- **P2-w** 草稿只在停手 300ms 后落盘,无 beforeunload 兜底 → 打完最后一字立刻关窗会丢;退群/删会话后草稿永不清理(分组有 prune,草稿没有)。`Composer.tsx:71-76`、`chat.ts:1179-1188`。
- **P2-x** 存储写满/被禁用时处理不一致:一半静默吞(显示已保存实际没存),一半直接抛(`saveWorkbenchConfig` 在 onClick 同步调,抛出后无 ErrorBoundary → 白屏)。`theme.ts:22`、`ado.ts:31-33`、`client.ts:50`。ErrorBoundary(P0-5)能兜住后半。
- **P2-y** 分组规则每次渲染重编正则(3 组×2 规则×200 会话 = 每条新消息重编 1200 次 RegExp),忙时掉帧。`folders.ts:33-39`(加缓存)。**注**:正则语法错误已兜(try/catch + 保存按钮禁用),不会崩。

---

## 四、桌面壳(Tauri)相关 Issue —— 多为"未实现"而非"坏了"

这几条对应 README 的 M4 路线图里本就列在"后续"的项(托盘/原生通知/自动更新)。需要在 `apps/desktop/src-tauri` 侧加 Rust 能力 + capabilities 权限。

- **#3 关闭软件直接退出,不是最小化到托盘** — 需加系统托盘 + 关闭拦截(`tauri-plugin-` 或自定义窗口事件)。中文办公软件的强预期。
- **#4 系统通知显示"已拒绝"** — 桌面通知走的是 Web Notification 还是 Tauri notification 插件?capabilities 里没有 notification 权限。需加 `tauri-plugin-notification` + 权限声明 + 首次请求授权引导。
- **#2 文件拖拽到聊天框不能发送** — Web 端 drop 事件 + Tauri 的 `fileDropEnabled`/`onDragDrop`。可能 web 层监听了但 Tauri 拦截了原生拖放,需两端对齐。

---

## 五、工作台 / ADO 功能 Issue

- **#11 已解决工作项和普通工作项没有区分** — 工作项列表按 state(Resolved/Closed vs Active)加视觉区分(删除线/置灰/分组)。
- **#12 我提的 PR 里没有记录信息** — PR 详情缺字段(评论/提交/状态历史?)。需查 ado 直连/bridge 拉的 PR 数据结构缺了什么。
- **#13 ADO 链接直接显示标题(feature)** — 粘贴 ADO 工作项/PR 链接时 unfurl 成带标题的卡片。已有 `#工作项号` 悬停卡片和 `entity.link` 机制可复用,把 URL 形态也接进去。
- **#10 PDF 解析失败** — `PdfView.tsx` 用 pdfjs 自渲染。需具体报错(某类 PDF?加密?字体?)才能定位,建议让报告者提供样例文件。

---

## 六、建议的修复批次

**批次 1(P0,先发一个补丁版)**:P0-1 死循环(+ while 保险)、P0-5 ErrorBoundary + theme 兜底。这两个改动小、影响大,先堵住"整个应用崩给用户看"的两条路。

**批次 2(认证与实时健壮性,一起做收益最大)**:P0-2 断线补消息、P0-3 login 失败处理、P1-9 多标签同步、P1-10 token 失效登出、P2-j 心跳超时。这几条同源,合起来就是"网络/认证异常时不再静默假死"。

**批次 3(消息核心,对应最痛的 Issue)**:P1-2 客户端生成 _id(根治重复+重试重发)、P1-1 引用回复(需先实机定位)、P1-3 切会话滚动、P1-7 anchor 残留。

**批次 4(数据安全)**:P0-4 本地数据按账号隔离、P1-8 title_link 协议校验、P1-11 成员错误态。

**批次 5(桌面壳)**:#3 托盘、#4 通知、#2 拖拽。独立于前端,可并行。

**批次 6(P2 清扫)**:markdown 边界(P2-a~e)、输入法与草稿(P2-f~i)、日历(P1-12/13、P2-s/t)、其余 P2。

---

## 附:被核实为"干净"的项(不用查)

- **zustand 稳定引用白屏坑**(architecture.md 第 95 行):三轮独立扫描约 120+ 处选择器,**没有复发**。所有派生数组都在选择器外 useMemo,`?? EMPTY` 都在选择器外。
- **markdown ReDoS / 超长文本**:260KB 文本 4.1ms,对抗性输入全部 <4ms,无灾难性回溯。
- **XSS via dangerouslySetInnerHTML**:全仓无此用法;markdown 链接硬性要求 `https?://`。唯一缺口是 P1-8(附件 title_link)。
- **权限判断 / DM 隐藏群管理**:`lib/roomAdmin.ts` 的 `isManageableType` 正确挡掉 `t='d'`,全局 admin 也看不到 DM 的管理操作。
- **日历重复规则大部分分支**:31 号月度回退月末、2/29 平年回退 2/28、跨月跨年跨闰年都对(错的只有 P1-12 的 0 次和 P2-s 的周日排序)。
- **跨房间结果与发送隔离**:v0.12.1 后异步结果按房间/关键词校验;Composer 与 ThreadPanel 显式传入发起时的 rid,邀请期间切换会话也不会发错房间。
- **JSON.parse 失败 / 字段缺失**:10 处 store load 全部 try/catch 兜底,不会崩(唯一例外是 P0-5 的 theme)。
- **React key**:消息列表用 `msg._id` 稳定;temp→真实 id 重挂载无可丢失的本地状态。
