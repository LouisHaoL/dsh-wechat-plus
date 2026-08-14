# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。所有日期为本地日期。

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
