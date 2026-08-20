# dsh-wechat-plus · DSH 微信桥接插件（项目/会话管理 + 智能路由版）

**[中文](#中文文档) | [English](#english-documentation)**

---

<a name="中文文档"></a>

把**手机微信**接到 **DeepSeek Harness (DSH)**：你在微信里给机器人发消息，DSH 的 AI 助手处理后把回复流式发回微信。本插件是 `dsh-wechat-bridge` 的升级重命名版，在原有消息桥接之上新增**多项目/会话管理**与 **embedding 智能路由**：在微信里即可切换项目、翻找历史会话、并让"日常闲聊"与"项目工作"自动分流。功能定位与 CC-Connect 的"微信消息中转"类似，但**本插件为完全独立的原创实现**，与 CC-Connect 无任何代码、配置或商标关联（详见下方合规说明）。

```
手机微信 ──▶ 腾讯 iLink Bot API（ilinkai.weixin.qq.com，官方开放协议）
                │  长轮询收消息 / sendmessage 回传
                ▼
        dsh-wechat-plus（本插件，DSH 内运行）
                │  命令拦截 → 智能路由 → ctx.agents.create/followup/resume
                ▼
        DeepSeek Harness AI Agent（DSH 官方 Agent 接口）
```

## 一、合规与"不侵权"说明

1. **全部代码原创**：本仓库代码为独立编写，未复制、未翻译、未借鉴 CC-Connect 的任何源码或配置文件；插件名、配置结构、命令集均为原创。
2. **微信通道合法**：走腾讯官方开放的「微信 ClawBot 插件功能」——iLink Bot 协议（域名 `ilinkai.weixin.qq.com`），受腾讯《微信 ClawBot 功能使用条款》约束，不是逆向 iPad 协议，也不是 PC 客户端 Hook。
3. **底层依赖宽松许可**：协议客户端使用独立开源项目 [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)（MIT 许可，零运行时依赖），其实现参考腾讯官方开源包 `@tencent-weixin/openclaw-weixin`。MIT 归属声明见 `THIRD_PARTY_NOTICES.md`。
4. **商标与命名**：不使用 "cc-connect" 名称、图标、文档文本或品牌元素。
5. **参考对象**：CC-Connect 本身为 MIT 许可项目；即使按其许可证也允许合法复用（保留声明），本项目选择了更保守的路线——完全不使用其代码，只实现"消息中转"这一通用功能概念（功能概念本身不受著作权保护）。

## 二、iLink 协议

腾讯为「微信 ClawBot 插件功能」开放的官方 Bot 协议，服务地址 `https://ilinkai.weixin.qq.com`。核心交互：长轮询（long-polling）收取消息、`sendmessage` 回传文本、`getUploadUrl` + CDN 回传图片/文件、"正在输入"状态上报。凭证为 Token + 账号 ID（扫码登录后自动获取并持久化）。本插件通过 MIT 许可的独立客户端 [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client) 使用该协议。

## 三、功能

- ✅ 手机微信私聊 → DSH AI 对话，回复**流式分段**发回（打字机效果，按句读边界切割不切词）
- ✅ **多项目/会话管理**：`/projects` `/project` `/sessions` `/home` `/new` `/stay` `/status` `/history` `/models` `/model` 全套命令，微信端直接切换项目与历史会话、切换模型（详见下节）
- ✅ **embedding 智能路由**：日常闲聊自动分流，项目相关消息自动切入对应项目（详见「智能路由」）
- ✅ 内置**扫码登录**：自动弹出二维码页面，微信扫码即完成绑定（也可直接配置已有 token）
- ✅ 每个联系人**独立绑定状态**（当前项目 + 会话指针），持久化、重启恢复
- ✅ 语音消息（转写文字后交给 AI）、文字消息
- ✅ **图片接收**：微信发图自动下载到工作目录，AI 用工具（OCR/看图）分析后回复
- ✅ **文件接收与回传**：入站文件自动下载供 AI 读取；AI 把生成的文件保存到 `wechat-outbox/<联系人>/` 自动发回微信；更有专属工具 `wechat_send_file` 与 `wechat_send_local_file`
- ✅ **微信排版**：回复里的 Markdown（加粗/表格/引用/列表/链接）自动转成微信可读的纯文本；非流式长回复自动加 (1/n) 分段编号
- ✅ **群聊（代码就绪，待平台开放）**：⚠️ 实测确认当前微信 ClawBot 机器人无法被拉入群聊（平台未开放），此功能暂不可用；平台开放后开箱即用
- ✅ **网页抓取（可选）**：配套极简 MCP fetch 服务器（`mcp/fetch-server/`），仅用户明确要求时抓取公开网页
- ✅ **定时任务**：cron 定时给指定联系人派活，配置热加载、无需重启
- ✅ **"正在输入…"提示**、**用量尾注**（每轮回复附模型与 token 统计）
- ✅ **白名单分级**：`allowFrom` 控制谁能聊；`admins` 控制谁能执行控制命令；支持 `override.json` 热调整
- ✅ 纯链接消息拦截（安全铁律）、断线/凭证过期自动重试、长轮询假死看门狗、空闲自动回收、单实例互斥
- ⏳ 暂不支持：入站视频消息（忽略并记日志）

## 四、会话与项目管理

每个联系人的消息都有明确的**归属指针**：当前项目（`日常` 或某个具体项目）+ 该项目下的当前会话。指针持久化在 `~/.dsh/wechat-plus/bindings.json`，重启自动恢复。

### 命令表

| 命令 | 行为 |
|---|---|
| `/projects` | 列出所有项目（`日常` 置顶），编号菜单 |
| `/project <n>` | 切到第 n 个项目，自动落在该项目**最近活跃的会话**（无会话则下一条消息自动新建） |
| `/sessions [页码或关键词]` | 列出**当前项目**下的会话（标题+时间，每页 ≤8 条，`n`=下一页；带关键词按标题过滤） |
| 回复数字 | 选中 `/sessions` 菜单中的会话，回显 `已切换：《标题》`，后续消息恢复该会话 |
| `/home` | 回到**日常模式** |
| `/new` | 当前项目另开新会话（旧会话保留，可从 `/sessions` 找回） |
| `/stay [小时]` | 钉住当前上下文（默认 2 小时），期间智能路由静默；无参数 = 查询剩余时间 |
| `/status` | 显示当前项目 / 会话 / stay 状态 / 当前模型 |
| `/history [n]` | 把当前会话最近 n 轮对话（默认 5）发到微信（自动脱敏，超长按 20 段截断） |
| `/models` | 列出可用模型（按 provider 分组，当前模型 ★ 标记），编号菜单 |
| `/model <n或名称>` | 切换当前联系人的模型：数字选菜单 / 模型 id（支持唯一子串匹配，多匹配会列出候选）/ 无参数显示当前模型。按联系人持久化（重启保留）；空闲时立即生效且保留会话上下文，任务运行中则本轮完成后生效 |
| `/help` | 帮助文本 |
| `/stop` | 中断当前正在处理的任务 |

所有斜杠命令在消息投递给 AI **之前**拦截处理，零 LLM 调用、即时响应。命令需**完全匹配**（trim 后以 `/` 开头且首 token 在命令表中）。

### 日常模式

- 新联系人默认落在伪项目 `日常`（`__daily__`，工作目录 `~/.dsh/daily/`），拥有**一个长生命周期会话**：上下文连续，agent 上下文窗口天然只装最近若干轮，更早轮次由会话持久化滚出窗口。
- 日常会话中的 agent 照常可用 OpenViking 记忆工具（viking_remember / viking_search），即自带长期记忆。

### 阶层约束（铁律）

1. `/sessions` **只列当前项目下的会话**（按会话工作目录过滤），不会跨项目串列。
2. `/project <n>` 切换后自动落在该项目的最近活跃会话；每个项目各自记住自己的会话指针（切走再切回，还在原会话）。
3. 会话恢复时强制使用**该会话自己的工作目录**，不做跨项目 resume。

### 编号菜单机制

- **单活跃菜单**：同一联系人同一时刻只有一个活跃菜单，新菜单出现即作废旧菜单。
- **短 TTL**：菜单 5 分钟未回复自动失效；失效后回复数字会提示 `菜单已失效，请重新 /sessions`。

## 五、智能路由

路由发生在消息投递给 AI **之前**（斜杠命令拦截之后）。判定为跑题的消息直接改投目标会话——被打断的会话从未见过该消息，不存在"撤回"问题。

### 决策表

```
消息到达
  ├─ 斜杠命令 → 命令层（最高优先级）
  ├─ /stay 未过期 → 原样投递当前指针
  ├─ 当前在【项目A】
  │   ├─ 与 A 高度相似 → 投 A
  │   ├─ 与 B 高度相似 且 出现工作意图 → 投 A + 一行切换建议（"这像【B】的活？1.切过去 2.就在这聊"）
  │   └─ 都低（纯闲聊）→ 投 A（项目里允许闲聊，不切出）
  └─ 当前在【日常】
      ├─ top1 且 top1−top2 > margin → 自动切项目 + 回复标头 + 可撤销提示
      ├─ top1/top2 歧义（差 ≤ margin）→ 三选一菜单 "1.【A】 2.【B】 3.留日常"
      └─ 都低于切入阈值 → 留日常
```

自动切入项目后，该轮回复带标头 `[已进入【项目A】·《会话标题》]`，尾部一行 `↩ /home 回日常`。

### routeMode 三档

| 档位 | 行为 |
|---|---|
| `auto`（默认） | 高置信度时自动切入项目（带标头、可撤销） |
| `ask` | 切入前先发三选一菜单确认 |
| `off` | 纯手动，不做任何自动切换 |

### 相似度服务（可插拔）

```yaml
- insert:
    - id: wechat-plus
      name: 'dsh-wechat-plus'
      config:
        routerEnabled: true          # 总开关（关闭后消息一律按当前指针直通）
        routerProvider: openviking   # 'openviking' | 'deepseek' | 'off'
        routerOpenvikingBaseUrl: 'http://127.0.0.1:1933'
        routeMode: auto              # 'auto' | 'ask' | 'off'
```

- **`openviking`（推荐）**：用本机 OpenViking 语义搜索做相似度，免费、无需 API key（dev 模式免鉴权）。
- **`deepseek`**：OpenAI 兼容 `/embeddings` 接口，需配置 `routerDeepseekApiKey`（可选 `routerDeepseekBaseUrl`、`routerDeepseekModel`），本地余弦相似度。
- **`off`**：不路由。

**降级安全网**：provider 不可达或调用失败时，路由一律降级为直通（按当前指针投递，限频记日志），**永不阻塞消息**。

### 阈值与校准（为什么默认 enter=0.75）

实测本机 OpenViking（0.4.15）相似度分布**整体偏高**：无关消息也能拿到 ~0.70，相关消息 ~0.876。规格初值 0.62 在这种分布下会过于激进（闲聊频繁误切项目），因此默认切入阈值提升到 `routerEnter = 0.75`，可按自己的服务实测调回。配套参数：

- `routerMargin = 0.08`：top1 与 top2 差值 ≤ 该值视为歧义，发三选一菜单。
- **迟滞**：项目 A 内要切到项目 B 需 `sim(B) > enter + 0.05`；本项目内不切出。
- **手动切换后 60 秒路由静默窗口**：不对抗用户的手动操作。
- **工作意图启发式**：祈使开头（来/继续/开始/修/写/跑/部署…）或含文件/命令操作词，仅用于触发"项目间切换建议"，不影响投递。

### 锚点与成本

- 每个项目维护一个**锚点**：该项目 `AGENTS.md`/`README.md` 前 2000 字 + 最近 6 轮对话摘要，缓存于 `~/.dsh/wechat-plus/anchors.json`（TTL 1 小时）。日常模式无锚点（只判项目相似度）。
- **embedding 调用成本**：每条入站消息仅做**一次**相似度查询（openviking provider 为一次 search 调用；deepseek provider 为消息一次 embedding + 与缓存的锚点向量本地余弦比较）。锚点向量有 1 小时缓存，不会每条消息重算。

## 六、安装

DSH 插件装在 profile 里（默认 `~/.dsh/profiles/web/`）。

> ⚠️ **代码更新提示（重要）**：DSH 的插件加载器会缓存已导入的模块，**修改插件源码后必须重启 DSH 才会加载新代码**（配置项改动则热加载，无需重启）。首次安装也建议装完即重启一次。开发迭代建议用 `link:` 方式安装（见方式 B）。

> 📦 **从 dsh-wechat-bridge 升级**：本插件状态目录为 `~/.dsh/wechat-plus/`。首次启动时若检测到旧目录 `~/.dsh/wechat-bridge/` 且新目录尚无数据，会**自动整体迁移**（token、会话索引、绑定状态全部保留），无需手动操作。

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
    - id: wechat-plus
      name: 'dsh-wechat-plus'
```

### 首次启用（扫码）

1. 插件默认 `enabled: true`，装好后没有凭证会自动进入扫码流程：自动弹出浏览器页面（`~/.dsh/wechat-plus/login.html`）显示二维码。
2. **手机微信扫码确认**。成功后插件保存凭证（`~/.dsh/wechat-plus/state.json`），开始收发。
3. 想先不激活，可在 patch 配置里加 `config: { enabled: false }`。

### 可选：网页抓取（MCP fetch 服务器）

让微信里的 AI 真正能读网页内容。自研约 150 行极简实现，只依赖官方 `@modelcontextprotocol/sdk`（MIT）与 `zod`（MIT）：

```powershell
cd mcp/fetch-server
npm install
```

然后在 profile 的 `cordis.patch.yml` 里挂载：

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

安全设计：仅 GET 公开 http/https 地址；拒绝 localhost/私网/环回地址（SSRF 防护）；20 秒超时、3 MB 下载上限、单次最多返回 10 万字符并支持分页续读；不执行任何抓取到的脚本。**只有用户明确要求抓取时 AI 才会调用**。

## 七、配置项

可在 DSH 设置界面（插件配置）或 `cordis.patch.yml` 的 `config` 中调整：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用桥接 |
| `token` / `accountId` | 空 | 已有 iLink 凭证（留空走扫码登录，推荐） |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 服务地址 |
| `allowFrom` | `["*"]` | 白名单（iLink 用户 ID）；建议收紧成你自己的 ID |
| `admins` | `[]` | 管理员列表：可执行控制命令；为空则所有人可执行 |
| `workDir` | 空 | AI 工作目录；留空用 DSH 当前工作区 |
| `blockLinks` | `true` | 拦截纯链接消息（安全铁律） |
| `streaming` | `true` | 流式分段发送 |
| `idleTimeoutMins` | `60` | 空闲多久自动结束会话（0=永不） |
| `maxReplyChars` | `1500` | 单条回复最大字符数（自动分段） |
| `loginCooldownSecs` | `30` | 登录失败重试间隔 |
| `wechatMarkdown` | `true` | 回复里的 Markdown 转微信友好纯文本 |
| `groups` / `groupRequireMention` | `true` | 群聊处理与 @ 触发（平台未开放，代码就绪） |
| `pollWatchdogSecs` | `90` | 长轮询假死看门狗（0=关闭） |
| `usageFooter` | `true` | 回复末尾附模型与用量统计 |
| `routerEnabled` | `true` | 启用 embedding 智能路由（关闭后按当前指针直通） |
| `routerProvider` | `openviking` | 相似度服务：`openviking` / `deepseek` / `off` |
| `routerOpenvikingBaseUrl` | `http://127.0.0.1:1933` | OpenViking 服务地址 |
| `routerDeepseekBaseUrl` | `https://api.deepseek.com` | deepseek provider 的 embeddings API 地址 |
| `routerDeepseekApiKey` | 空 | deepseek provider 的 API key |
| `routerDeepseekModel` | 空 | deepseek provider 的 embedding 模型名（留空用服务端默认） |
| `routerMargin` | `0.08` | 歧义判定边际（top1−top2 ≤ 该值发三选一菜单） |
| `routerEnter` | `0.75` | 日常→项目切入阈值（实测校准值，见上文） |
| `routeMode` | `auto` | 路由模式：`auto` / `ask` / `off` |

运行时覆盖配置：`~/.dsh/wechat-plus/override.json`（可选，约 5 秒热加载、删除自动回退），可运行时调整 `allowFrom`、`admins` 与 cron `jobs`。

## 八、安全注意事项

- **`/history` 脱敏**：回发到微信的对话历史经过正则脱敏——API key、Bearer token、密码赋值、长随机串、手机号一律替换为 `***`；长历史分段复用安全发送，单次上限 20 段，超出提示。
- **白名单**：`allowFrom` 建议只保留你自己的微信 ID（登录日志会打印）；陌生消息一律不进 AI。`admins` 控制命令权限。
- **隐私告知（embedding 锚点）**：启用 openviking provider 的智能路由时，插件会把各项目的锚点文本（项目 `AGENTS.md`/`README.md` 前 2000 字 + 最近 6 轮对话摘要）作为资源写入**本机** OpenViking 实例（`wechat-plus-route/` 前缀），用于计算相似度。该数据只写入你本机的 OpenViking，不会发送到任何第三方；如介意，可将 `routerProvider` 设为 `off` 或改用 `deepseek` provider（消息 embedding 只经 API 计算、不落库）。
- 插件只做消息中转：不执行任何来自微信的命令行指令，纯链接默认拦截；高危操作由 DSH 本身的权限确认机制把关。

## 九、自动化测试

```powershell
cd <插件仓库路径>
npm install          # 首次
node --test          # 单元测试（路由决策表全分支、阈值/迟滞/静默窗口、菜单 TTL、脱敏、绑定持久化）
npm run test         # 全量集成测试（真实 DSH 服务树 + 真实模型 + 模拟微信客户端）
node test/unit.mjs   # 纯单元测试（CI 亦运行此套）
```

> 测试环境自动隔离在 `test/.home`（复制你的凭证与模型配置），不污染真实 DSH 数据。

## 十、故障排查

- **日志**：`~/.dsh/wechat-plus/bridge.log`（登录、扫码、路由决策、每条消息处理都记录）
- **重新扫码**：删除 `~/.dsh/wechat-plus/state.json` 后重启 DSH
- **凭证过期**：插件自动重新进入扫码流程
- **收不到消息**：确认插件已启用，看日志里 `开始接收微信消息…` 是否出现
- **路由不生效**：`/status` 查看当前绑定；确认 `routerEnabled: true` 且 `routerProvider` 对应服务可达（provider 失败会降级直通并限频记日志）
- **杀毒软件误报**：Windows Defender 可能误判 `lib/index.js`（实测 `Trojan:Script/Obfuscript.A!ml`）。处理：对 `lib` 目录添加排除、从隔离区还原后重启 DSH、可对照 `git status` 核实文件未被篡改。

## 十一、已知限制

- 单联系人同一时间只处理一个任务，连续发消息会排队依次处理
- 入站视频消息暂不支持；纯链接消息默认拦截
- 运行中任务：切换项目/会话时若当前会话 busy，仅提示 `当前会话有任务运行中（未中断）`，任务不杀
- 会话标题超长截断（≤24 字符 + …）
- 旧版 DSH 缺少 `sessionQuery`/`workspaceRegistry` 服务时，会话/项目命令降级提示 `当前 DSH 版本不支持`

## 十二、免责声明

- 微信侧能力受腾讯《微信 ClawBot 功能使用条款》约束，请勿用于骚扰、营销、违反微信规则等用途。
- 本项目作者不对因违反腾讯条款、误配置白名单、AI 输出内容造成的任何损失负责。

---

<a name="english-documentation"></a>

# dsh-wechat-plus · DSH WeChat Bridge Plugin (Project/Session Management + Smart Routing)

**[中文](#中文文档) | [English](#english-documentation)**

Connect your **phone's WeChat** to **DeepSeek Harness (DSH)**: send messages to the bot in WeChat, a DSH AI agent handles them, and replies stream back to WeChat. This plugin is the upgraded, renamed successor of `dsh-wechat-bridge`, adding **multi-project/session management** and **embedding-based smart routing** on top of the original bridge: switch projects, browse past sessions, and let "daily chat" and "project work" route themselves — all from WeChat. Functionally comparable to CC-Connect's "WeChat message relay" concept, but this is a **fully independent original implementation** with no code, config, or trademark relationship to CC-Connect (see compliance notes below).

```
Phone WeChat ──▶ Tencent iLink Bot API (ilinkai.weixin.qq.com, official open protocol)
                     │  long-polling for messages / sendmessage for replies
                     ▼
             dsh-wechat-plus (this plugin, runs inside DSH)
                     │  command interception → smart routing → ctx.agents.create/followup/resume
                     ▼
             DeepSeek Harness AI Agent (official DSH Agent interface)
```

## 1. Compliance & Non-Infringement

1. **Fully original code**: written independently; no source or config copied, translated, or derived from CC-Connect. Plugin name, config schema, and command set are original.
2. **Legal WeChat channel**: uses Tencent's officially opened "WeChat ClawBot plugin capability" — the iLink Bot protocol (domain `ilinkai.weixin.qq.com`), governed by Tencent's ClawBot terms. Not a reverse-engineered iPad protocol, not a PC client hook.
3. **Permissive dependencies**: protocol access via the independent open-source [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client) (MIT, zero runtime deps), which references Tencent's official open-source `@tencent-weixin/openclaw-weixin`. MIT attribution in `THIRD_PARTY_NOTICES.md`.
4. **Trademarks & naming**: no "cc-connect" names, icons, doc text, or brand elements.
5. **Reference target**: CC-Connect itself is MIT-licensed and legal reuse would be permitted with attribution; this project takes the more conservative route — zero use of its code, implementing only the generic concept of "message relay" (functional concepts are not copyrightable).

## 2. iLink Protocol

Tencent's official Bot protocol for the "WeChat ClawBot plugin capability", served at `https://ilinkai.weixin.qq.com`. Core interactions: long-polling to receive messages, `sendmessage` for text replies, `getUploadUrl` + CDN for images/files, and typing-status reporting. Credentials are a Token + account ID (obtained automatically after QR-code login and persisted). This plugin uses it via the MIT-licensed [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client).

## 3. Features

- ✅ WeChat private chat → DSH AI conversation, replies **streamed in segments** (typewriter effect, cut at sentence boundaries — never mid-word)
- ✅ **Multi-project/session management**: `/projects` `/project` `/sessions` `/home` `/new` `/stay` `/status` `/history` (see next section)
- ✅ **Embedding smart routing**: daily chat stays put; project-relevant messages auto-switch to the right project (see "Smart Routing")
- ✅ Built-in **QR-code login** (auto-pops a login page; existing token can also be configured)
- ✅ Per-contact **binding state** (current project + session pointer), persisted, restored on restart
- ✅ Voice messages (transcribed then handed to AI), text messages
- ✅ **Image reception**: images auto-download to the work dir; AI analyzes them with tools (OCR/vision)
- ✅ **File reception & delivery**: inbound files auto-download for AI to read; AI-generated files saved to `wechat-outbox/<contact>/` auto-send back to WeChat; dedicated tools `wechat_send_file` and `wechat_send_local_file`
- ✅ **WeChat typography**: Markdown (bold/tables/quotes/lists/links) auto-converted to WeChat-friendly plain text; long non-streamed replies get (1/n) segment numbering
- ✅ **Group chat (code-ready, awaiting platform)**: ⚠️ confirmed by testing that ClawBot bots currently **cannot join group chats** (platform not open); ready out-of-the-box once opened
- ✅ **Web fetching (optional)**: minimal MCP fetch server (`mcp/fetch-server/`); fetches public pages only when explicitly requested
- ✅ **Cron jobs**: schedule prompts to contacts; hot-reloaded config
- ✅ **Typing indicator**, **usage footer** (model & token stats per reply)
- ✅ **Tiered allowlist**: `allowFrom` gates who can chat; `admins` gates control commands; hot-reloadable via `override.json`
- ✅ Pure-link interception (security rule), auto-reconnect on expiry, poll watchdog, idle recycling, single-instance mutex
- ⏳ Not supported: inbound video messages (ignored & logged)

## 4. Session & Project Management

Each contact's messages have an explicit **ownership pointer**: current project (`Daily` or a concrete project) + the current session within that project. Pointers persist in `~/.dsh/wechat-plus/bindings.json` and survive restarts.

### Command table

| Command | Behavior |
|---|---|
| `/projects` | List all projects (`Daily` pinned on top), numbered menu |
| `/project <n>` | Switch to project n; lands on its **most recently active session** (or the next message starts a new one) |
| `/sessions [page or keyword]` | List sessions **of the current project** (title+time, ≤8 per page, `n`=next page; keyword filters by title) |
| Reply with a number | Selects a session from the `/sessions` menu, echoes `已切换：《title》`, subsequent messages resume it |
| `/home` | Return to **Daily mode** |
| `/new` | Start a new session in the current project (old session kept, findable via `/sessions`) |
| `/stay [hours]` | Pin the current context (default 2h); smart routing stays silent; no arg = query remaining time |
| `/status` | Show current project / session / stay state / current model |
| `/history [n]` | Send the last n turns (default 5) of the current session to WeChat (auto-redacted; capped at 20 segments) |
| `/models` | List available models grouped by provider (current model ★), numbered menu |
| `/model <n or name>` | Switch model for the current contact: number picks from menu / model id (unique-substring match; ambiguous matches list candidates) / no arg shows current. Persisted per contact (survives restarts); takes effect immediately when idle (session context kept), or after the running turn when busy |
| `/help` | Help text |
| `/stop` | Interrupt the running task |

All slash commands are intercepted **before** delivery to the AI — zero LLM calls, instant response. Commands must match **exactly** (trimmed, starts with `/`, first token in the command table).

### Daily mode

- New contacts default to the pseudo-project `Daily` (`__daily__`, workdir `~/.dsh/daily/`) with **one long-lived session**: context stays continuous; older turns roll out of the model window via session persistence.
- The agent in a Daily session can still use OpenViking memory tools (viking_remember / viking_search) — long-term memory built in.

### Hierarchy constraints (iron rules)

1. `/sessions` lists **only sessions under the current project** (filtered by session working directory) — no cross-project mixing.
2. `/project <n>` lands on that project's most recently active session; each project remembers its own session pointer (switch away and back, you're still in the same session).
3. Session resume always uses **that session's own working directory** — no cross-project resume.

### Numbered-menu mechanics

- **Single active menu**: a contact has at most one active menu; a new menu invalidates the old.
- **Short TTL**: menus expire after 5 minutes; replying a number afterwards gets `菜单已失效，请重新 /sessions`.

## 5. Smart Routing

Routing happens **before** delivering a message to the AI (after slash-command interception). A message judged off-topic is delivered to the target session directly — the interrupted session never sees it, so there is no "recall" problem.

### Decision table

```
Message arrives
  ├─ Slash command → command layer (highest priority)
  ├─ /stay not expired → deliver to current pointer as-is
  ├─ Currently in [Project A]
  │   ├─ Similar to A → deliver to A
  │   ├─ Similar to B + work intent → deliver to A + one-line switch suggestion ("Looks like [B]'s job? 1. Switch  2. Stay here")
  │   └─ Both low (pure chat) → deliver to A (chatting inside a project is fine; never switches out)
  └─ Currently in [Daily]
      ├─ top1 and top1−top2 > margin → auto-switch project + header + undo hint
      ├─ top1/top2 ambiguous (gap ≤ margin) → three-way menu "1.[A] 2.[B] 3.Stay in Daily"
      └─ All below threshold → stay in Daily
```

After an automatic switch, the reply carries a header `[已进入【ProjectA】·《session title》]` and a trailing line `↩ /home 回日常`.

### routeMode levels

| Level | Behavior |
|---|---|
| `auto` (default) | Auto-switch on high confidence (with header, reversible) |
| `ask` | Send a three-way confirmation menu before switching |
| `off` | Fully manual, no automatic switching |

### Similarity provider (pluggable)

```yaml
- insert:
    - id: wechat-plus
      name: 'dsh-wechat-plus'
      config:
        routerEnabled: true          # master switch (off = deliver to current pointer)
        routerProvider: openviking   # 'openviking' | 'deepseek' | 'off'
        routerOpenvikingBaseUrl: 'http://127.0.0.1:1933'
        routeMode: auto              # 'auto' | 'ask' | 'off'
```

- **`openviking` (recommended)**: similarity via your local OpenViking semantic search — free, no API key (auth-free in dev mode).
- **`deepseek`**: OpenAI-compatible `/embeddings` endpoint; requires `routerDeepseekApiKey` (optional `routerDeepseekBaseUrl`, `routerDeepseekModel`); cosine similarity computed locally.
- **`off`**: no routing.

**Fallback safety net**: if the provider is unreachable or fails, routing degrades to pass-through (deliver per current pointer, rate-limited logging) — **messages are never blocked**.

### Thresholds & calibration (why enter=0.75 by default)

Measured on local OpenViking (0.4.15), similarity scores are **systematically high**: irrelevant messages score ~0.70, relevant ones ~0.876. The original spec value of 0.62 would be far too aggressive under that distribution (frequent false switches on casual chat), so the default entry threshold is raised to `routerEnter = 0.75`; adjust to your own service's measurements. Related parameters:

- `routerMargin = 0.08`: if top1−top2 ≤ this value it's ambiguous → three-way menu.
- **Hysteresis**: switching from project A to project B requires `sim(B) > enter + 0.05`; never switches out within the current project.
- **60-second routing silence after a manual switch**: never fight the user.
- **Work-intent heuristic**: imperative openings (continue/fix/write/run/deploy…) or file/command operation words — only triggers the cross-project *suggestion*, never changes delivery.

### Anchors & cost

- Each project maintains an **anchor**: the first 2000 chars of its `AGENTS.md`/`README.md` plus a summary of the last 6 conversation turns, cached in `~/.dsh/wechat-plus/anchors.json` (1-hour TTL). Daily mode has no anchor (only project similarity is judged).
- **Embedding cost**: each inbound message triggers exactly **one** similarity query (openviking: one search call; deepseek: one message embedding + local cosine against cached anchor vectors). Anchor vectors are cached for 1 hour and are not recomputed per message.

## 6. Installation

DSH plugins install into a profile (default `~/.dsh/profiles/web/`).

> ⚠️ **Code-update note (important)**: DSH's plugin loader caches imported modules — **restart DSH after changing plugin source** (config changes hot-reload without restart). Restart once after first install too. Use the `link:` method (Method B) for development.

> 📦 **Upgrading from dsh-wechat-bridge**: the state directory is now `~/.dsh/wechat-plus/`. On first start, if the legacy `~/.dsh/wechat-bridge/` exists and the new directory has no data yet, it is **migrated automatically and wholesale** (token, session index, bindings all preserved) — no manual steps.

### Method A: official command (if the dsh CLI is installed)

```powershell
# Open PowerShell outside DSH and run:
dsh plugin --profile web add "<path to this repo>"
```

> `dsh plugin` is DSH's built-in plugin manager (forwards to pnpm and syncs the bundle list).
> **Restart DSH** after install for the bundle to take effect.

### Method B: manual install (`link:`, recommended for development)

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add "link:<path to this repo>"
```

> Use `link:` (not `file:`): node_modules gets a symlink — edit source, restart DSH, done.

> ⚠️ **Runtime peer-dep resolution**: the repo sits outside DSH's install tree, so Node ESM can't reach the host's `@deepseek-ai/*` packages (`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`). The `postinstall` script (`scripts/ensure-host-junction.mjs`) junction-links peer packages from the host's node_modules — **running `npm install` in the repo sets it up automatically**. If you skipped it with `--legacy-peer-deps`, run `node scripts/ensure-host-junction.mjs`.

```yaml
- insert:
    - id: wechat-plus
      name: 'dsh-wechat-plus'
```

### First run (QR code)

1. With the default `enabled: true` and no credentials, the plugin auto-starts QR login: a browser page pops up (`~/.dsh/wechat-plus/login.html`) showing the QR code.
2. **Scan with WeChat on your phone**. Credentials are saved to `~/.dsh/wechat-plus/state.json` and messaging starts.
3. To keep it inactive, add `config: { enabled: false }` in the patch.

### Optional: web fetching (MCP fetch server)

Lets the WeChat-side AI actually read web pages. A ~150-line original implementation depending only on the official `@modelcontextprotocol/sdk` (MIT) and `zod` (MIT):

```powershell
cd mcp/fetch-server
npm install
```

Mount it in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-fetch
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fetch
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'   # absolute path to node.exe on your machine
        args:
          - '<repo path>\mcp\fetch-server\server.mjs'
        cwd: '<repo path>\mcp\fetch-server'
        toolCallTimeoutMs: 60000
        failOnStartupError: true
```

Security design: GET public http/https only; rejects localhost/private/loopback addresses (SSRF protection); 20s timeout, 3 MB cap, ≤100k chars per response with pagination; never executes fetched scripts. **The AI calls it only when the user explicitly asks.**

## 7. Configuration

Adjustable in the DSH settings UI or `cordis.patch.yml` `config`:

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable the bridge |
| `token` / `accountId` | empty | Existing iLink credentials (empty = QR login, recommended) |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink service URL |
| `allowFrom` | `["*"]` | Allowlist (iLink user IDs); tighten to your own ID |
| `admins` | `[]` | Admins who may run control commands; empty = everyone |
| `workDir` | empty | AI working directory; empty = current DSH workspace |
| `blockLinks` | `true` | Intercept pure-link messages (security rule) |
| `streaming` | `true` | Stream replies in segments |
| `idleTimeoutMins` | `60` | Auto-end session after idle minutes (0 = never) |
| `maxReplyChars` | `1500` | Max chars per WeChat reply (auto-segmented) |
| `loginCooldownSecs` | `30` | Retry interval after login failure |
| `wechatMarkdown` | `true` | Convert Markdown to WeChat-friendly plain text |
| `groups` / `groupRequireMention` | `true` | Group handling & @-trigger (platform not open; code ready) |
| `pollWatchdogSecs` | `90` | Poll watchdog (0 = off) |
| `usageFooter` | `true` | Append model & usage stats to replies |
| `routerEnabled` | `true` | Enable embedding smart routing (off = pass-through) |
| `routerProvider` | `openviking` | Similarity service: `openviking` / `deepseek` / `off` |
| `routerOpenvikingBaseUrl` | `http://127.0.0.1:1933` | OpenViking service URL |
| `routerDeepseekBaseUrl` | `https://api.deepseek.com` | Embeddings API URL for the deepseek provider |
| `routerDeepseekApiKey` | empty | API key for the deepseek provider |
| `routerDeepseekModel` | empty | Embedding model name (empty = server default) |
| `routerMargin` | `0.08` | Ambiguity margin (top1−top2 ≤ value → three-way menu) |
| `routerEnter` | `0.75` | Daily→project entry threshold (calibrated default, see above) |
| `routeMode` | `auto` | Routing mode: `auto` / `ask` / `off` |

Runtime overrides: `~/.dsh/wechat-plus/override.json` (optional, hot-reloaded in ~5s, auto-reverts on deletion) for `allowFrom`, `admins`, and cron `jobs`.

## 8. Security Notes

- **`/history` redaction**: conversation history sent to WeChat passes regex redaction — API keys, bearer tokens, password assignments, long random strings, and phone numbers are all replaced with `***`; long output is safely segmented with a 20-segment cap per invocation.
- **Allowlist**: keep only your own WeChat ID in `allowFrom` (printed in login logs); strangers never reach the AI. `admins` gates control commands.
- **Privacy notice (embedding anchors)**: with the openviking provider enabled, the plugin writes each project's anchor text (first 2000 chars of the project's `AGENTS.md`/`README.md` plus a summary of the last 6 turns) as resources into your **local** OpenViking instance (prefixed `wechat-plus-route/`) for similarity computation. This data stays on your machine and is never sent to third parties; if this concerns you, set `routerProvider` to `off` or switch to the `deepseek` provider (message embeddings are computed via the API only, nothing is stored).
- The plugin only relays messages: it executes no shell commands from WeChat content, intercepts pure links by default; dangerous operations remain gated by DSH's own permission confirmation.

## 9. Automated Tests

```powershell
cd <repo path>
npm install          # first time
node --test          # unit tests (routing decision table branches, thresholds/hysteresis/silence window, menu TTL, redaction, binding persistence)
npm run test         # full integration tests (real DSH service tree + real model + mocked WeChat client)
node test/unit.mjs   # pure unit tests (also run in CI)
```

> Tests auto-isolate in `test/.home` (copies your credentials & model config) — no pollution of real DSH data.

## 10. Troubleshooting

- **Logs**: `~/.dsh/wechat-plus/bridge.log` (login, QR, routing decisions, every message)
- **Re-scan QR**: delete `~/.dsh/wechat-plus/state.json` and restart DSH
- **Expired credentials**: the plugin auto-restarts the QR flow
- **No messages arriving**: check the plugin is enabled and `开始接收微信消息…` appears in the log
- **Routing not working**: `/status` to inspect bindings; ensure `routerEnabled: true` and the provider service is reachable (provider failure degrades to pass-through with rate-limited logs)
- **Antivirus false positives**: Windows Defender may flag `lib/index.js` (observed `Trojan:Script/Obfuscript.A!ml`). Fix: exclude the `lib` directory, restore from quarantine, restart DSH; verify integrity with `git status`.

## 11. Known Limitations

- One task per contact at a time; consecutive messages queue in order
- Inbound video not supported; pure links intercepted by default
- Running tasks: switching project/session while busy only warns `当前会话有任务运行中（未中断）` — the task is not killed
- Session titles truncated (≤24 chars + …)
- On older DSH lacking `sessionQuery`/`workspaceRegistry`, session/project commands degrade with a `当前 DSH 版本不支持` notice

## 12. Disclaimer

- WeChat-side capabilities are governed by Tencent's WeChat ClawBot terms of use; do not use for spam, marketing, or anything violating WeChat rules.
- The author is not liable for losses caused by violating Tencent's terms, misconfigured allowlists, or AI output.
