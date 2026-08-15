# dsh-wechat-bridge · DSH 微信桥接插件

把**手机微信**接到 **DeepSeek Harness (DSH)**：你在微信里给机器人发消息，DSH 的 AI 助手处理后把回复流式发回微信。功能定位与 CC-Connect 的"微信消息中转"类似，但**本插件为完全独立的原创实现**，与 CC-Connect 无任何代码、配置或商标关联（详见下方合规说明）。

**English** — A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that connects your phone's WeChat to a DSH AI agent through Tencent's official iLink / ClawBot protocol: streaming replies, QR-code login, per-contact sessions with persistence, cron jobs, and an optional self-hosted web-fetch MCP server. MIT licensed, fully original implementation.

```
手机微信 ──▶ 腾讯 iLink Bot API（ilinkai.weixin.qq.com，官方开放协议）
                │  长轮询收消息 / sendmessage 回传
                ▼
        dsh-wechat-bridge（本插件，DSH 内运行）
                │  ctx.agents.create + followup + 会话日志流
                ▼
        DeepSeek Harness AI Agent（DSH 官方 Agent 接口）
```

## 一、合规与"不侵权"说明

1. **全部代码原创**：本仓库代码为独立编写，未复制、未翻译、未借鉴 CC-Connect 的任何源码或配置文件；插件名、配置结构、命令集均为原创。
2. **微信通道合法**：走腾讯官方开放的「微信 ClawBot 插件功能」——iLink Bot 协议（域名 `ilinkai.weixin.qq.com`），受腾讯《微信 ClawBot 功能使用条款》约束，不是逆向 iPad 协议，也不是 PC 客户端 Hook。
3. **底层依赖宽松许可**：协议客户端使用独立开源项目 [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)（MIT 许可，零运行时依赖），其实现参考腾讯官方开源包 `@tencent-weixin/openclaw-weixin`。MIT 归属声明见 `THIRD_PARTY_NOTICES.md`。
4. **商标与命名**：不使用 "cc-connect" 名称、图标、文档文本或品牌元素。
5. **参考对象**：CC-Connect 本身为 MIT 许可项目；即使按其许可证也允许合法复用（保留声明），本项目选择了更保守的路线——完全不使用其代码，只实现"消息中转"这一通用功能概念（功能概念本身不受著作权保护）。

## 二、功能

- ✅ 手机微信私聊 → DSH AI 对话，回复**流式分段**发回（打字机效果）
- ✅ 内置**扫码登录**：自动弹出二维码页面，微信扫码即完成绑定（也可直接配置已有 token）
- ✅ 每个联系人**独立 AI 会话**，互不串扰；`/new` 清空上下文重开
- ✅ **会话持久化**：DSH 重启后按联系人恢复上一次对话上下文
- ✅ 语音消息（转写文字后交给 AI）、文字消息
- ✅ **图片接收**：微信发图自动下载到工作目录，AI 用工具（OCR/看图）分析后回复
- ✅ **文件接收**：微信发 PDF/Word/文本等文件自动下载，AI 直接读取分析
- ✅ **微信排版**：回复里的 Markdown（加粗/表格/引用/列表/链接）自动转成微信可读的纯文本；非流式长回复自动加 (1/n) 分段编号
- ✅ **群聊**：群里 @机器人 即触发 AI 回复（按群维护独立会话，白名单按成员生效；可关闭）
- ✅ **网页抓取（可选）**：配套极简 MCP fetch 服务器（`mcp/fetch-server/`），AI 仅在用户明确要求时抓取公开网页（内置内网地址拦截、20 秒超时、3 MB 上限），无需桌面端审批
- ✅ **文件回传**：AI 把生成的图表/文档保存到 `wechat-outbox/<联系人>/` 即自动发送到你微信
- ✅ **定时任务**：cron 定时给指定联系人派活（如"每天早上 7 点推送行业头条"），配置热加载、无需重启
- ✅ **"正在输入…"提示**：AI 思考时微信端显示输入中
- ✅ **白名单分级**：`allowFrom` 控制谁能聊；`admins` 控制谁能执行 `/new /stop /status`；支持 `override.json` 热调整
- ✅ 纯链接消息拦截（安全铁律）、断线/凭证过期自动重试、长轮询假死看门狗、空闲自动回收、单实例互斥
- ✅ 命令：`/help` `/new` `/stop` `/status`
- ⏳ 暂不支持：入站视频消息（忽略并记日志）

### 运行时覆盖配置（override.json，热加载）

`~/.dsh/wechat-bridge/override.json`（可选，修改后约 5 秒生效、删除自动回退）：

```json
{
  "allowFrom": ["<你的 iLink 用户 ID>"],
  "admins": ["<你的 iLink 用户 ID>"],
  "jobs": [
    { "id": "morning-news", "cron": "0 7 * * *", "prompt": "收集今天 AI 行业头条并总结要点", "to": "<你的 iLink 用户 ID>" }
  ]
}
```

- `jobs[].cron`：5 段 cron（分 时 日 月 星期，星期 0=周日），支持 `*/n`、列表、区间
- `jobs[].to`：任务目标联系人，必须是管理员（防篡改骚扰他人）
- 任务结果走正常流式链路回传微信

## 三、安装

DSH 插件装在 profile 里（默认 `~/.dsh/profiles/web/`）。

> ⚠️ **代码更新提示（重要）**：DSH 的插件加载器会缓存已导入的模块，**修改插件源码后必须重启 DSH 才会加载新代码**（配置项改动则热加载，无需重启）。首次安装也建议装完即重启一次，确保运行的就是最新代码。开发迭代建议用 `link:` 方式安装（见方式 B）。

### 方式 A：官方命令（如本机已安装 dsh CLI）

```powershell
# 在 DSH 之外打开 PowerShell，执行：
dsh plugin --profile web add "<插件仓库路径>"
```

> `dsh plugin` 是 DSH 自带的插件管理命令（本质是把参数转发给 pnpm 并同步 bundle 列表）。
> 装完后**重启 DSH** 使 bundle 生效。

### 方式 B：手动安装（`link:` 链接，推荐开发迭代用）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add "link:<插件仓库路径>"
```

> 用 `link:`（而不是 `file:`）安装：node_modules 里是符号链接，改完源码重启 DSH 即生效，无需重装。

> ⚠️ **运行时 peer 依赖解析**：插件目录在 DSH 应用安装树之外，Node ESM 解析够不到主机自带的
> `@deepseek-ai/*` 包（会报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`）。
> 因此本仓库通过 `postinstall`（`scripts/ensure-host-junction.mjs`）自动把 peer 包以 junction
> 链接到主机安装目录的 node_modules——**在插件仓库里跑过 `npm install` 即自动建立**。
> 若曾用 `--legacy-peer-deps` 跳过，可手动执行 `node scripts/ensure-host-junction.mjs` 补链。

```yaml
- insert:
    - id: wechat-bridge
      name: '@zxz9988/dsh-wechat-bridge'
```

### 方式 C：npm 发布版（普通用户推荐）

```powershell
dsh plugin --profile web add @zxz9988/dsh-wechat-bridge
# 或手动：
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add @zxz9988/dsh-wechat-bridge
```

> npm 上另有他人发布的同名非 scoped 包（`dsh-wechat-bridge`，作者 gtaifu），与本项目无关；
> 本项目的官方包名是 **`@zxz9988/dsh-wechat-bridge`**，请勿混淆。

### 首次启用（扫码）

1. 插件默认 `enabled: true`，装好后没有凭证会自动进入扫码流程：
   自动弹出浏览器页面（`~/.dsh/wechat-bridge/login.html`）显示二维码。
2. **手机微信扫码确认**。成功后插件保存凭证（`~/.dsh/wechat-bridge/state.json`），开始收发。
3. 想先不激活，可在 patch 配置里加 `config: { enabled: false }`。

```yaml
- insert:
    - id: wechat-bridge
      name: '@zxz9988/dsh-wechat-bridge'
      config:
        enabled: false
```

### 可选：网页抓取（MCP fetch 服务器）

让微信里的 AI 真正能读网页内容（回答"帮我看下这篇新闻讲了什么"这类请求）。自研约 150 行极简实现，只依赖官方 [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)（MIT）与 `zod`（MIT），不引入任何第三方 fetch 服务器。

```powershell
cd mcp/fetch-server
npm install
```

然后在 profile 的 `cordis.patch.yml` 里挂载（`dsh-mcp-client` 由 DSH 自带，工具名固定为 `mcp__fetch__fetch`；`failOnStartupError: true` 让启动失败可见而不是静默）：

```yaml
- insert:
    - id: mcp-fetch
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fetch
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'   # 换成你机器上 node.exe 的绝对路径
        args:
          - '<仓库路径>\mcp\fetch-server\server.mjs'
        cwd: '<仓库路径>\mcp\fetch-server'
        toolCallTimeoutMs: 60000
        failOnStartupError: true
```

安全设计：仅 GET 公开 http/https 地址；拒绝 localhost/`*.local`/私网与环回 IPv4/IPv6（SSRF 防护）；20 秒超时、3 MB 下载上限、单次最多返回 10 万字符并支持 `startIndex` 分页续读；不执行任何抓取到的脚本。该工具无需桌面端审批即可被微信侧智能体调用，但**只有用户明确要求抓取时 AI 才会调用**（安全铁律第 4 条）。

## 四、配置项

可在 DSH 设置界面（插件配置）或 `cordis.patch.yml` 的 `config` 中调整：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用桥接 |
| `token` / `accountId` | 空 | 已有 iLink 凭证（留空走扫码登录，推荐） |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 服务地址 |
| `allowFrom` | `["*"]` | 白名单（iLink 用户 ID）；建议用 `override.json` 收紧成你自己的 ID |
| `admins` | `[]` | 管理员列表：可执行 `/new /stop /status`；为空则所有人可执行 |
| `workDir` | 空 | AI 工作目录；留空用 DSH 当前工作区 |
| `blockLinks` | `true` | 拦截纯链接消息（安全铁律） |
| `streaming` | `true` | 流式分段发送 |
| `idleTimeoutMins` | `60` | 空闲多久自动结束会话（0=永不） |
| `maxReplyChars` | `1500` | 单条回复最大字符数（自动分段） |
| `loginCooldownSecs` | `30` | 登录失败重试间隔 |
| `wechatMarkdown` | `true` | 把回复里的 Markdown（加粗/表格/引用/列表/链接）转成微信友好的纯文本 |
| `groups` | `true` | 处理群聊消息（开启后仅响应 @机器人 的消息） |
| `groupRequireMention` | `true` | 群聊仅当消息 @机器人 时才响应（关闭则响应群内所有文字消息） |
| `pollWatchdogSecs` | `90` | 长轮询静默超过该秒数判定假死，自动重启监听（0=关闭） |

## 五、自动化测试

插件自带三套测试（单元测试可在任何环境/CI 运行；集成测试用真实 DSH 服务树 + 真实 DeepSeek 模型 + 模拟微信客户端）：

```powershell
cd <插件仓库路径>
npm install          # 首次
npm run test         # 全量集成测试（默认 2 轮；--rounds=N 可调）
npm run test:smoke   # iLink 官方接口冒烟测试（获取二维码，不登录）
node test/unit.mjs   # 纯单元测试（CI 亦运行此套）
```

集成测试覆盖 43 项断言：真实模型问答回传、流式分段防切词（按句读边界切割）、`/status` `/help` `/new` 命令、
白名单、`/new` 竞态、多联系人会话隔离、消息排队顺序、`/stop` 中断、凭证过期自动重登、
重启恢复（凭证持久化）、非流式整段发送、图片接收、定时任务、正在输入提示、outbox 文件回传、空闲回收、优雅关闭。

> 测试环境自动隔离在 `test/.home`（复制你的凭证与模型配置），不污染真实 DSH 数据。

## 六、安全铁律对照（2026-07-30 生效版）

| 铁律 | 本插件行为 |
|---|---|
| 1. 网页命令先确认再执行 | 插件不执行任何来自微信的命令行指令 |
| 2. 外部内容入库前先过目 | 微信消息只进 AI 会话，插件不直接写 Obsidian/知识库 |
| 3. 高危操作强制中断 | AI 侧高危操作由 DSH 本身的权限确认机制把关；插件不代答确认 |
| 4. 微信机器人只做消息转发 | ✅ 插件只做消息中转；纯链接默认拦截，不自动处理微信中的链接；可选网页抓取仅在用户明确要求时进行 |
| 5. AI 提方案，人拍板 | 微信端适合问答与产出，涉系统级操作建议回到 DSH 桌面端确认 |

**建议**：`allowFrom` 只保留你自己的微信 ID（登录日志会打印），陌生消息一律不进 AI。

## 七、故障排查

- **日志**：`~/.dsh/wechat-bridge/bridge.log`（登录状态、扫码状态、每条消息处理都记录）
- **重新扫码**：删除 `~/.dsh/wechat-bridge/state.json` 后重启 DSH（或重载插件）
- **凭证过期**：插件自动重新进入扫码流程，弹二维码后扫码即可
- **收不到消息**：确认插件已启用（DSH 设置 → 插件列表），看日志里 `开始接收微信消息…` 是否出现
- **与 CC-Connect 并存**：两边是独立的 iLink Bot 凭证（各自扫码），互不干扰；同一个凭证不能被两个程序同时长轮询

## 八、已知限制

- 单联系人同一时间只处理一个任务，连续发消息会排队依次处理（与聊天工具习惯一致）
- 入站视频消息暂不支持（纯链接消息默认拦截）
- 极少数情况下模型可能长时间无输出（如 API 抖动），微信端暂无提示；可发 `/stop` 或稍后重发（错误会以页脚形式回传）
- 微信回复按 `maxReplyChars` 分段（默认 1500 字）；超长内容会拆成多条依次发送

## 九、免责声明

- 微信侧能力受腾讯《微信 ClawBot 功能使用条款》约束，请勿用于骚扰、营销、违反微信规则等用途。
- 本项目作者不对因违反腾讯条款、误配置白名单、AI 输出内容造成的任何损失负责。
