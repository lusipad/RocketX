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
>   工作项模板地址、AI Provider（按 kind|baseUrl|model 指纹比对；PAT 与
>   AI 密钥永不改动）。
>
> 未实现（后续迭代）：定时同步与 diff 提醒（§4）、git 克隆来源、
> 首次使用清单集成与逐项连通性探测向导（§5）、updater 端点展示。

## 1. 问题

一个新成员（或换机的老成员）要把 RocketX 用起来，目前需要手工填一串分散配置：

| 配置 | 现状存储 | 位置 |
| --- | --- | --- |
| Rocket.Chat 服务器地址 | `localStorage['rcx-server']` | `apps/web/src/lib/client.ts` |
| ADO 地址 / 认证 / 模式 | `localStorage['rcx-workbench']`（含 PAT 明文） | `apps/web/src/lib/ado.ts` |
| AI Provider（endpoint/model/key） | `localStorage['rcx-ai-settings-v1']` | `apps/web/src/kernel/ai/config.ts` |
| 工作项模板地址 | `localStorage['rcx-wi-template-url']` | `apps/web/src/stores/wiTemplates.ts` |
| 更新包地址 | 编译期写死 `tauri.conf.json` updater.endpoints | `apps/desktop/src-tauri/tauri.conf.json` |
| 全局快捷键等杂项 | 各自的 localStorage key | 分散 |

每一项都要人肉从别处抄，配错一项对应模块就静默不可用。issue #67 的诉求：
从 git 或文件读取一份配置，自动探测可用性；git 来源可以自动同步；有引导向导。

## 2. 目标 / 非目标

**目标**

1. 一份 `rcx.workspace.json` 描述文件即可完成除凭据外的全部配置。
2. 支持三种来源：本地文件导入、HTTP(S) URL、git 仓库（桌面端）。
3. 导入走引导向导：逐项探测可达性（复用现有 ADO 自动探测的思路），成功打勾、失败给出原因。
4. URL / git 来源可选「跟随更新」：定期拉取，字段有变化时提示用户确认后应用。

**非目标**

- 集中管控 / 强制下发（政企向已冻结，见 blueprint §11）。配置永远是「用户主动导入 + 本地可覆盖」。
- 在配置文件里存放任何秘密（PAT、AI key、密码）。
- 运行时切换更新包地址（Tauri updater 端点是编译期签名配置，放进描述文件只做展示与校验）。

## 3. 配置文件格式（草案）

```jsonc
{
  "$schema": "https://rocketx.dev/schemas/workspace-v1.json",
  "version": 1,
  "name": "某某团队工作区",
  "rocketChat": { "url": "https://chat.example.com" },
  "ado": {
    "url": "http://ado.example.com/tfs/DefaultCollection",
    "mode": "direct",            // direct | bridge
    "auth": "pat",               // pat | ntlm | none —— 只声明方式，不含凭据
    "defaultProject": "Alpha"
  },
  "workItemTemplates": { "url": "https://git.example.com/team/rcx-config/raw/templates.json" },
  "ai": {
    "providers": [
      { "kind": "deepseek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "keyEnv": "RCX_AI_KEY" }
    ]
  },
  "apps": { "registry": "https://apps.example.com/registry.json" },
  "updater": { "endpoint": "https://github.com/lusipad/RocketX/releases/latest/download/latest.json" }
}
```

要点：

- **凭据永远不进文件。** `keyEnv` 声明环境变量名（桌面端读取）；Web 端在向导对应步骤提示手工粘贴。
  ADO PAT 同理，向导只在「ADO」这一步弹出输入框。
- 所有字段可选，缺省字段跳过对应向导步骤，不覆盖本地已有值。
- schema 校验复用 app-sdk 的「单一解析器」模式：一个 `parseWorkspaceConfig()` 纯函数 + 回归测试，
  Web / 桌面 / CLI 三端共用。

## 4. 来源与同步

| 来源 | 获取方式 | 同步 |
| --- | --- | --- |
| 本地文件 | 文件选择器 / 拖入 | 一次性导入，无同步 |
| HTTP(S) URL | `fetch`（同源限制下走桌面端或代理） | 记住 URL，启动时 + 每 24h 拉取比对 |
| git 仓库 | 桌面端浅克隆到应用数据目录（凭据走系统 git credential helper） | `git fetch` 比对 HEAD |

同步策略：**拉取到差异 → 弹「配置有更新」摘要（逐字段 diff）→ 用户确认后应用**。
不做静默覆盖：本地手改过的字段标记为 `localOverride`，同步永不覆盖，除非用户在 diff 里主动勾选。

## 5. 引导向导

入口：设置页「从配置文件导入」+ 首次使用清单（`FirstUseChecklist`）新增一项。

步骤（每步实时探测，通过打勾）：

1. 选择来源（文件 / URL / git）并解析校验 schema；
2. Rocket.Chat：`/api/info` 可达性 + 版本兼容矩阵检查；
3. ADO：复用 `直连自动探测`（路径 + 认证）；`auth: pat` 时弹 PAT 输入；
4. AI：`keyEnv` 有值则发一次最小请求验证，无值提示补填或跳过；
5. 模板 / 应用源：拉取一次并 schema 校验；
6. 汇总页：写入各 localStorage key（复用现有 save 函数，不引入第二套存储），
   记录来源元数据 `localStorage['rcx-workspace-source']` 供同步用。

## 6. 安全

- 配置文件视为**不可信输入**：所有 URL 必须是 http(s)，拒绝 javascript:/file:；解析失败整体拒绝。
- 从 URL/git 导入时展示来源与字段全文，防钓鱼配置指向恶意 RC/ADO 服务器——首次导入必须人工确认每个服务器地址。
- 同步差异应用同样需要确认（见 §4），避免仓库被篡改后静默改写服务器地址。
- PAT / AI key 保持现状存储（localStorage / 环境变量）；桌面端迁移到系统 keychain 是独立改进项，不阻塞本提案。

## 7. 里程碑建议

1. **P1**：schema + `parseWorkspaceConfig()` + 本地文件导入向导（覆盖 rocketChat/ado/ai/templates 四项）。
2. **P2**：URL 来源 + 24h 同步 diff 确认。
3. **P3**：git 来源（桌面端）+ 首次使用清单集成 + 动效打磨。
