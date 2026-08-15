# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。所有日期为本地日期。

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
