# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。所有日期为本地日期。

## [0.5.0] - 2026-08-15

### 新增
- **文件/图片上传修复（关键）**：iLink 服务端已把 `getUploadUrl` 响应从旧字段 `upload_param` 切换到新字段 `upload_full_url`，而 `wechat-ilink-client@0.1.0`（npm 无新版）只认旧字段，导致 outbox 文件回传全线失败（"getUploadUrl returned no upload_param"）。现自实现上传段：兼容新旧两种响应、AES-128-ECB 加密、POST 到预签名地址、下载参数取 CDN 响应头 `x-encrypted-param`（官方 openclaw-weixin@2.4.6 同款流程）；图片与文件统一走此路径。另加连续失败上限（5 次后移入 `failed/` 停止重试，避免每 2 秒重试刷屏）。
- **用量尾注**：每轮 AI 回复末尾自动附 `⚙ 模型 · out 输出 · in 输入 · ctx 上下文`（tokenMeter 服务重放会话计算，provider 用量锚点缺失时仅显示 ctx；异常不影响回复）。配置 `usageFooter`（默认开）。
- **专属文件交付工具**：注册 `wechat_send_file`（直接写内容交付文件）与 `wechat_send_local_file`（发送工作目录内已有文件）两个全局工具——不依赖 Agent 预设组合，微信侧智能体必然可见。实测发现模型在生成 HTML 报告时只把代码贴到聊天里，并声称"手上只有网页抓取一个工具"；现将文件交付变成确定性能力：工具写入联系人的 outbox 目录后由扫描器自动发送，并把工具用法注入 Agent 作用域提示。`wechat_send_local_file` 有工作目录安全边界（拒绝外发工作区外文件）。修复：工具定义补充 `output` 声明（注册曾被 ToolRuntime 以 "must declare output" 拒绝）。
- **微信排版优化**：新增流式安全的 markdown-lite 渲染器（`createWeChatMarkdownRenderer`，纯函数）：`**加粗**`/行内码/删除线/`[链接](url)` 转纯文本、`| 表格 |` 两列转「a：b」多列对齐、`> 引用`/`# 标题` 去标记、`- 列表` 转 `• `、```代码块原样透传；逐行处理、跨片状态保留（与流式消毒器同构）。配置 `wechatMarkdown`（默认开）。非流式长回复自动加 `(1/n)` 分段编号。
- **入站文件接收**：微信发 PDF/Word/文本等文件自动下载到 `wechat-attachments/`（文件名清洗防路径穿越），路径交给 AI 读取分析；发送前回执「📎 收到 N 个文件」。入站视频仍不支持。
- **群聊支持**：开启 `groups`（默认）后处理群消息：按群维护独立会话、白名单按发送成员校验、`groupRequireMention`（默认开）仅当消息 @机器人 时响应（匹配账号 ID/本地名/"@"开头，附群消息字段诊断日志）、控制命令按发送者鉴权、回传目标为群 ID。群聊无"正在输入"能力，自动跳过。
- **长轮询假死看门狗**：`pollWatchdogSecs`（默认 90 秒）内无任何 poll 事件判定假死，自动重启监听（monitorLoop 冷却后重建）。实测曾出现 `iLink 客户端错误：fetch failed` 后长轮询静默挂起的情况。

## [0.4.1] - 2026-08-15

### 发布
- **正式发布到 npm**：`@zxz9988/dsh-wechat-bridge`（0.4.1 为 npm 首个公开版本）。用户可 `npm i @zxz9988/dsh-wechat-bridge` 或 `dsh plugin --profile web add @zxz9988/dsh-wechat-bridge` 安装。
- **包名 scoped 化**：bundle 补丁行名、profile 依赖键、bundles 条目三处同步改为 scoped 全名（DSH 加载器按 node_modules 目录名解析，必须一致）。npm 上非 scoped 同名包（gtaifu 的 `dsh-wechat-bridge`）与本项目无关。
- 说明：0.4.0 曾短暂发布，因 npm registry 读副本延迟导致匿名读取数十分钟不可见（写入侧已确认版本存在）；随后发布 0.4.1 并确认公开可见。两版本均已在线。

## [0.4.0] - 2026-08-15

### 新增
- **纯函数模块 `lib/pure.js`**：流式消毒器、cron 解析器、流式发送安全断点（`safeSendCut`）抽为**零依赖**模块；单元测试改从 pure.js 导入，在任意环境（含 GitHub Actions CI）**零安装**即可运行，永久规避 npm registry 上 `@deepseek-ai/*` 各 rc 包之间的 peer 版本冲突（`dsh-home-paths@rc.3` 与其余 rc.6 包对 `dsh-invariants` 的要求不兼容）。
- **CI 双任务**：`unit`（checkout 后直接语法检查 + 单元测试，无 install 步骤）+ `install-smoke`（`--legacy-peer-deps --ignore-scripts` 验证直接依赖在全新环境可安装）。宿主 peer 由 DSH 运行时提供。

### 修复
- **fetch MCP：ANSI 颜色码剥离**：wttr.in 等接口会返回带终端颜色转义的文本，直接回传微信会出现乱码，现统一剥离。
- **fetch MCP：网络错误附带原因码**：黑盒的 `fetch failed` 改为 `network fetch failed (UND_ERR_CONNECT_TIMEOUT) for <host>` 等带诊断信息，模型可向用户准确解释失败原因（超时/DNS/连接重置）。
- **/stop 集成测试适配**：原提示词（无标点重复 60 遍）在句读边界流式分段下整段缓冲到回合结束，/stop 必然落空；改为含句号重复 120 遍。

### 变更（开源前审查）
- **敏感信息清除**：`POST_RESTART_CHECKLIST.md` 曾含真实机器人账号与个人微信 ID，已从工作区与**全部 git 历史**（filter-branch + gc）中清除，本地副本同步脱敏并加入 .gitignore。
- **调试文件出库**：`test/debug-*.mjs`、`test/make-instrumented.mjs` 不再跟踪。
- **README**：本机路径泛化、测试断言数修正（24→43）、wechat-ilink-client API 清单修正（新增 TypingStatus、移除 extractText）。
- **THIRD_PARTY_NOTICES**：补全 MCP fetch 服务器依赖（`@modelcontextprotocol/sdk`、`zod`，均 MIT）。
- **.gitignore**：覆盖运行时状态（`jobs-state.json`、`*.bak`）与 AI 工作目录产物（`wechat-attachments/`、`wechat-outbox/`）。

## [0.3.0] - 2026-08-15

### 新增
- **网页抓取（MCP fetch 服务器）**：配套极简 MCP 服务器 `mcp/fetch-server/`（约 150 行，仅依赖官方 `@modelcontextprotocol/sdk` 与 `zod`，均为 MIT）。经 DSH 自带 `@deepseek-ai/dsh-mcp-client` 挂载后，微信侧 AI 可调用 `mcp__fetch__fetch` 抓取公开网页（HTML→纯文本/原始 HTML/JSON，支持分页续读）。内置 SSRF 防护（拒绝 localhost/私网/环回地址）、20 秒超时、3 MB 下载上限、单次最多 10 万字符。官方 `@modelcontextprotocol/server-fetch` 已从 npm 下架，且社区替代包维护状况不明，故按"MIT-only、极简可控"原则自研。该工具零权限要求、不经过审批 seam，微信（无桌面审批 UI）可直接调用。

### 移除
- **TTS 语音播报**：按"辅助功能若影响稳定性则删除"原则整体移除（代码、依赖 msedge-tts、子进程脚本）。该功能依赖境外第三方语音服务，本机网络实测不可达且历史上两次引发应用级故障；移除后系统依赖面更小、更稳。如未来需要，可作为独立可选插件重新实现。

### 新增
- **文件回传（outbox）**：AI 把文件保存到工作目录 `wechat-outbox/<联系人>/` 即自动发送到用户微信（每 Agent 作用域注入路径说明）。

### 修复
- **流式分段不再切词**：模型流停顿点常在词中间，此前缓冲到 240 字或空闲 450ms 即整段发送，会产生"抓\n取成功""Shang\nhai"这类半词碎片。现按句读/空白/URL 分隔符（`/?&=`）边界切割，词中间的部分留在缓冲等后续流补齐；无安全断点时暂缓发送。新增 `safeSendCut` 纯函数与 3 项单元测试（实测证据：微信端天气回复曾把 "Shanghai" 切成 "Shang|hai"）。同步调整 `/stop` 集成测试：原提示词（无标点重复 60 遍）在新逻辑下整段缓冲到回合结束才发出，/stop 必然落在任务结束后；改为含句号重复 120 遍，保证流式分段在回合中持续发出。
- **contextToken 全链路持久化**：①首条消息即写入索引（此前新联系人首条消息不落 token）；②恢复会话时合并保存（此前覆盖丢失）；③空闲回收只清会话 ID、保留 token（此前删除导致次日定时推送失败）。定时任务由此可在重启/空闲后正常主动推送。
- **TTS 子进程 Electron 兼容**：在 Electron 宿主中 `process.execPath` 是应用 exe，子进程启动时注入 `ELECTRON_RUN_AS_NODE=1` 使其以纯 Node 模式运行。
- **TTS 子进程隔离**：msedge-tts 内部存在无 catch 的游离 Promise，网络异常时未处理拒绝会触发 DSH 的 fail-loud 机制导致整个应用周期性退出；TTS 现全部在子进程（`scripts/tts-worker.mjs`）执行，第三方库任何异常都不会波及 DSH。注：本机网络实测微软 Edge 朗读服务不可达，TTS 保持默认关闭；开启时服务不可达会静默跳过，不影响文字回复。
- **peer 依赖解析**：`postinstall` 自动把 `@deepseek-ai/*` 以 junction 链接到 DSH 主机 node_modules，避免 `npm install`（尤其 `--legacy-peer-deps`）重建后 DSH 启动报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`。

### 新增
- **微信图片接收**：收到图片自动下载到工作目录 `wechat-attachments/`，把路径交给 AI 用工具（OCR/看图）分析后回复；发送前回执"📷 正在分析"。
- **定时任务**：`override.json` 配置 `jobs`（5 段 cron），定时给指定联系人派活，结果流式回传；目标限管理员、防篡改；`jobs-state.json` 记录最近触发，重启不重复。
- **GitHub CI**：`.github/workflows/ci.yml`（语法检查 + 纯单元测试 `test/unit.mjs`，不依赖 DSH 服务树）。
- 测试套件每次运行自动清理插件侧状态（会话索引/任务状态/覆盖配置），保证可重复。

## [0.2.0] - 2026-08-15

### 新增
- **白名单分级**：`admins` 配置项 + `override.json` 运行时覆盖文件（热加载、删除自动回退），控制命令（`/new` `/stop` `/status`）仅管理员可用，普通用户只能聊天。
- **会话持久化**：`chats.json` 联系人→会话索引 + `agents.resume()`，DSH 重启后按联系人恢复上一次 AI 会话上下文。
- 流式消毒器扩充：`<bash>`（本环境实测格式）、`<tool_call>`、`<function_call>` 等标签。

### 修复
- override.json 删除后正确回退到 patch 配置（此前会残留旧值）。

## [0.1.0] - 2026-08-14

### 新增（首个可用版本）
- 手机微信（腾讯 iLink/ClawBot 官方协议）→ DSH AI 助手桥接，流式回传。
- 内置扫码登录（登录页自动刷新、单次弹出）、凭证持久化、断线/过期自动重登。
- 每联系人独立会话；命令：`/help` `/new` `/stop` `/status`。
- 安全：联系人白名单、纯链接拦截、只做消息中转。
- **流式文本消毒器**：剥离工具调用 XML 与思维链块（跨分片标签状态机）。
- **单例互斥锁**：防止多实例抢消息、回复交错（bridge.lock 心跳）。
- 生命周期：`ctx.effect` 清理、`inject: [agents, sessions, timer]`。
- 自动化集成测试 28 项（真实 DSH 服务树 + 真实模型 + 模拟微信客户端）。

### 合规
- 原创实现，零 CC-Connect 代码；依赖仅 MIT 许可（wechat-ilink-client、qrcode）；详见 `THIRD_PARTY_NOTICES.md`。
