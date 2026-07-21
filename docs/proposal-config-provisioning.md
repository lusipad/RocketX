# 提案：工作区配置描述文件与引导式配置（issue #67）

> 状态：**一期已落地**，2026-07-18。确认的核心语义：**配置提供默认值，
> 用户自己修改过的字段保留本地值，其余字段跟随配置**。
>
> 已实现（设置页新增「工作区」分区）：
> - `rcx.workspace.json` 解析与校验（`lib/workspaceConfig.ts`，凭据内嵌一律拒绝）；
> - 来源：URL 拉取（含 Git raw 地址）与本地文件导入；
> - 字段级预览与勾选应用：本地空值默认写入、与配置一致跳过、
>   「本地已修改」默认保留（可勾选强制覆盖）；判定依据是「本地值是否等于
>   上次从配置应用的值」（`rcx-workspace-source` 应用记录）；
> - 覆盖字段：Rocket.Chat 地址、ADO 地址/模式/认证方式/Web 链接地址、
>   工作项模板地址、AI Provider（按 kind|baseUrl|model 指纹比对）。配置文件
>   永不携带凭据；ADO/AI 端点变化时会解绑旧 PAT/密钥状态，避免把凭据发给新服务。
>
> 二期已落地（2026-07-22 加固）：**定时同步与 diff 提醒（§4）**——URL 来源默认
> 「跟随更新」（可关），启动时检查，并由运行中定时器保证每 24 小时拉取一次；失败会提示，出现「会被默认勾选」的变化时
> toast 提醒，点「查看」进与手动导入相同的字段预览，**永不静默改配置**；
> schema 新增 `update`（更新源三模式，issue #106 后已是运行时可配）与
> `workItems.hierarchyLayout`（层级工作项六形态默认值）。
>
> 首次启动整合已落地（2026-07-22）：桌面新安装默认先从团队共享、无需登录的 Raw URL
> 或本地文件导入 `rcx.workspace.json`，确认非敏感配置后只进入个人身份验证；
> 加入前会探测 Rocket.Chat；ADO、AI 与模板在个人凭据补齐后验证。个人模式保留为次要入口。
>
> 未实现（后续迭代）：私有仓库 clone/credential-helper 来源。当前“Git 地址”特指
> 无需登录即可读取文件内容的 Raw URL；私有配置可改用受控 HTTP 或本地文件。

## 1. 问题

一个新成员（或换机的老成员）要把 RocketX 用起来，目前需要手工填一串分散配置：

| 配置 | 现状存储 | 位置 |
| --- | --- | --- |
| Rocket.Chat 服务器地址 | `localStorage['rcx-server']` | `apps/web/src/lib/client.ts` |
| ADO 地址 / 认证 / 模式 | `localStorage['rcx-workbench']`（含 PAT 明文） | `apps/web/src/lib/ado.ts` |
| AI Provider（endpoint/model/key） | `localStorage['rcx-ai-settings-v1']` | `apps/web/src/kernel/ai/config.ts` |
| 工作项模板地址 | `localStorage['rcx-wi-template-url']` | `apps/web/src/stores/wiTemplates.ts` |
| 更新源 | `localStorage['rcx-update-source']` | `apps/web/src/lib/updateSource.ts` |
| 全局快捷键等杂项 | 各自的 localStorage key | 分散 |

每一项都要人肉从别处抄，配错一项对应模块就静默不可用。issue #67 的诉求：
从 git 或文件读取一份配置，自动探测可用性；git 来源可以自动同步；有引导向导。

## 2. 目标 / 非目标

**目标**

1. 一份 `rcx.workspace.json` 描述文件即可完成除凭据外的全部配置。
2. 支持本地文件与无需登录的 HTTP(S) URL（包括 Git Raw URL）。
3. 首次加入时先探测 Rocket.Chat；需要个人凭据的 ADO/AI 在相应设置保存时验证。
4. URL 来源可选「跟随更新」：定期拉取，字段有变化时提示用户确认后应用。

可复制并按团队环境修改 [`docs/examples/rcx.workspace.sample.json`](examples/rcx.workspace.sample.json)。

**非目标**

- 集中管控 / 强制下发（政企向已冻结，见 blueprint §11）。配置永远是「用户主动导入 + 本地可覆盖」。
- 在配置文件里存放任何秘密（PAT、AI key、密码）。
- 私有 git 仓库 clone、分支管理与 credential helper 集成。

## 3. 配置文件格式（草案）

```json
{
  "version": 1,
  "name": "某某团队工作区",
  "rocketChat": { "url": "https://chat.example.com" },
  "ado": {
    "url": "http://ado.example.com/tfs/DefaultCollection",
    "mode": "direct",
    "auth": "pat",
    "webUrl": "http://ado.example.com/tfs/DefaultCollection"
  },
  "workItemTemplates": { "url": "https://git.example.com/team/rcx-config/raw/templates.json" },
  "ai": {
    "providers": [
      { "id": "team-default", "kind": "openai-compatible", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" }
    ]
  },
  "update": { "source": "dir", "location": "\\\\fileserver\\share\\rocketx" },
  "workItems": { "hierarchyLayout": "feature-split" }
}
```

要点：

- **凭据永远不进文件。** ADO PAT、AI 密钥和 Rocket.Chat 密码由用户在本机单独填写。
- 所有字段可选，缺省字段跳过对应向导步骤，不覆盖本地已有值。
- schema 校验复用 app-sdk 的「单一解析器」模式：一个 `parseWorkspaceConfig()` 纯函数 + 回归测试，
  Web / 桌面 / CLI 三端共用。

## 4. 来源与同步

| 来源 | 获取方式 | 同步 |
| --- | --- | --- |
| 本地文件 | 文件选择器 / 拖入 | 一次性导入，无同步 |
| HTTP(S) URL | `fetch`（同源限制下走桌面端或代理） | 记住 URL，启动时 + 每 24h 拉取比对 |
| Git Raw URL | 与普通 HTTP(S) URL 相同；当前必须无需登录即可访问 | 与 URL 相同 |

同步策略：**拉取到差异 → 弹「配置有更新」摘要（逐字段 diff）→ 用户确认后应用**。
不做静默覆盖：本地手改过的字段标记为 `localOverride`，同步永不覆盖，除非用户在 diff 里主动勾选。

## 5. 引导向导

入口：桌面端首次启动默认显示「加入团队」，设置页「工作区」仍可重新导入或同步配置。

当前步骤：

1. 选择本地文件或无需登录的 URL，并解析校验配置；
2. 展示 Rocket.Chat、ADO、AI（含 Base URL 与模型）等非敏感目标供用户确认；
3. Rocket.Chat：调用 `/api/info` 验证目标确实可达；
4. 汇总并写入各本地配置（复用现有 save 函数，不引入第二套存储），
   记录来源元数据 `localStorage['rcx-workspace-source']` 供同步用。
5. 登录后由用户分别补齐 ADO PAT / AI 密钥；相关模块沿用各自的连接验证。

## 6. 安全

- 配置文件视为**不可信输入**：所有 URL 必须是 http(s)，拒绝 javascript:/file:；解析失败整体拒绝。
- 从 URL/git 导入时展示来源与字段全文，防钓鱼配置指向恶意 RC/ADO 服务器——首次导入必须人工确认每个服务器地址。
- 同步差异应用同样需要确认（见 §4），避免仓库被篡改后静默改写服务器地址。
- Rocket.Chat 地址变化会立即清理旧会话并要求重新登录；ADO/AI 端点变化会解绑对应旧凭据。
- HTTP 与共享目录更新都要求 `latest.json` 含 Tauri Minisign `signature`，并使用与官方更新相同的公钥验证安装包；目录可信不等于安装包可信。

## 7. 里程碑建议

1. **P1**：schema + `parseWorkspaceConfig()` + 本地文件导入向导（覆盖 rocketChat/ado/ai/templates 四项）。
2. **P2**：URL 来源 + 24h 同步 diff 确认。
3. **P3**：首次启动团队引导 + Rocket.Chat 探测 + 端点凭据隔离 + 自定义更新源签名校验。
4. **后续**：如确有需求，再实现私有 git clone 与 credential helper 集成。
