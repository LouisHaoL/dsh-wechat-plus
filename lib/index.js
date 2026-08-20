// dsh-wechat-plus — DSH 微信桥接插件（项目/会话管理 + 智能路由版）
//
// 把手机微信（腾讯 iLink / ClawBot 官方开放协议）连接到 DeepSeek Harness 的
// AI 助手：微信收到文字/语音消息 → 交给 DSH Agent → 把回复流式发回微信。
//
// 设计原则（对照《安全铁律》与合规要求）：
//   1. 只做消息中转 —— 插件本身不执行任何来自微信内容的系统命令、不代开链接。
//   2. 白名单 —— allowFrom 只允许名单内的联系人（默认全开，建议收紧）。
//   3. 纯链接消息默认拦截，不送入 AI。
//   4. 本文件为原创实现；微信协议走腾讯官方开放的 iLink Bot API，
//      底层使用 MIT 许可的独立开源客户端 wechat-ilink-client（见 THIRD_PARTY_NOTICES.md）。

import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, renameSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, isAbsolute, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import qrcode from 'qrcode'
import { WeChatClient, MessageType, MessageItemType, TypingStatus, UploadMediaType, encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl } from 'wechat-ilink-client'
import { parseCron, nextCronAfter, safeSendCut, createStreamSanitizer, createWeChatMarkdownRenderer, fmtTokens } from './pure.js'

// 兼容导出：集成测试与外部消费者仍从插件入口导入这些纯函数
export { parseCron, nextCronAfter, safeSendCut, createStreamSanitizer, createWeChatMarkdownRenderer, fmtTokens }

export const name = 'wechat-plus'
// 本 Cordis 分支对 ctx 属性访问是严格模式：用到的服务必须声明在 inject 里
// （timer 用于 ctx.setInterval 的 fiber 级定时器；tools 用于注册微信专属工具）
export const inject = ['agents', 'sessions', 'timer', 'tools']

/** 插件配置（可在 DSH 设置界面或 cordis.patch.yml 中调整）。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('启用微信桥接（关闭后不登录、不收发消息）。'),
  token: z.string().default('').description('已有 iLink Bot Token（留空则用扫码登录，推荐）。'),
  accountId: z.string().default('').description('已有 iLink 账号 ID（与 token 配套，留空自动读取）。'),
  baseUrl: z.string().default('https://ilinkai.weixin.qq.com').description('iLink 服务地址。'),
  allowFrom: z.array(z.string()).default(['*']).description('消息白名单（iLink 用户 ID；"*" 表示所有人）。'),
  admins: z.array(z.string()).default([]).description('管理员列表（iLink 用户 ID）：可执行 /new /stop /status 等控制命令；为空则所有人可执行。'),
  workDir: z.string().default('').description('AI 工作目录（留空则用 DSH 当前工作区）。'),
  blockLinks: z.boolean().default(true).description('拦截纯链接消息，不送入 AI（安全铁律）。'),
  streaming: z.boolean().default(true).description('边生成边分段发送回复（关闭则整段完成后发送）。'),
  idleTimeoutMins: z.number().default(60).description('空闲多少分钟后自动结束本次会话（0 = 永不）。'),
  maxReplyChars: z.number().default(1500).description('单条微信回复的最大字符数，超出自动分段。'),
  loginCooldownSecs: z.number().default(30).description('登录失败 / 凭证过期后，重试前的等待秒数。'),
  singleton: z.boolean().default(true).description('多实例互斥：同一时间只允许一个桥接实例运行（防止双实例抢消息）。'),
  typing: z.boolean().default(true).description('思考时向微信发送"正在输入…"状态提示。'),
  waitNoteSecs: z.number().default(10).description('AI 思考超过该秒数仍无输出时，主动发一条"正在处理"提示（0=关闭）。'),
  outbox: z.boolean().default(true).description('文件回传：AI 把文件保存到工作目录 wechat-outbox/<联系人>/ 后自动发送到微信。'),
  wechatMarkdown: z.boolean().default(true).description('把回复里的 Markdown（加粗/表格/引用/列表/链接）转成微信友好的纯文本。'),
  groups: z.boolean().default(true).description('处理群聊消息（开启后仅响应 @机器人 的消息）。'),
  groupRequireMention: z.boolean().default(true).description('群聊仅当消息 @机器人 时才响应（关闭则响应群内所有文字消息）。'),
  pollWatchdogSecs: z.number().default(90).description('长轮询静默超过该秒数判定假死，自动重启监听（0=关闭）。'),
  usageFooter: z.boolean().default(false).description('每轮 AI 回复末尾附上模型与用量统计（GUI 同格式）。默认关闭：微信端聊天体验优先，需要时开启。'),
  usageFooterPath: z.string().default('~/.dsh-wechat-plus').description('用量尾注末尾的路径标签。'),
  // ===== 智能路由（SPEC 第 3 节）=====
  routerEnabled: z.boolean().default(true).description('启用 embedding 智能路由（关闭后消息一律按当前指针直通）。'),
  routerProvider: z.string().default('openviking').description("相似度服务：'openviking'（本机 OpenViking 语义搜索，推荐）| 'deepseek'（OpenAI 兼容 embeddings 接口）| 'off'（不路由）。"),
  routerOpenvikingBaseUrl: z.string().default('http://127.0.0.1:1933').description('OpenViking 服务地址（本机默认端口 1933，鉴权沿用其 dev 模式免鉴权）。'),
  routerDeepseekBaseUrl: z.string().default('https://api.deepseek.com').description('deepseek provider 的 embeddings API 地址（OpenAI 兼容 /embeddings）。'),
  routerDeepseekApiKey: z.string().default('').description('deepseek provider 的 API key（走 openviking 时无需填写）。'),
  routerDeepseekModel: z.string().default('').description('deepseek provider 的 embedding 模型名（留空用服务端默认）。'),
  routerMargin: z.number().default(0.08).description('歧义判定边际：top1−top2 ≤ 该值时发三选一菜单。'),
  routerEnter: z.number().default(0.75).description('日常→项目切入阈值（项目间切换再加迟滞 +0.05）。实测 OpenViking 相似度分布整体偏高（无关消息也 ~0.70），故默认 0.75；SPEC 初值 0.62 可按需调低。'),
  routeMode: z.string().default('auto').description("路由模式：'auto'（高置信自动切）| 'ask'（切入前先发菜单确认）| 'off'（纯手动）。")
})

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const TICK_MS = 350          // 流式缓冲的节拍
const FLUSH_IDLE_MS = 450    // 距上次发送超过该时长即发送缓冲
const FLUSH_SIZE = 240       // 缓冲超过该字数即发送
const SEEN_CAP = 1000        // 去重集合上限
const MAX_LOG_BYTES = 2 * 1024 * 1024
const OVERRIDE_FILENAME = 'override.json'   // 运行时覆盖配置（白名单/管理员，热加载）
const CHAT_INDEX_FILENAME = 'chats.json'    // 联系人 → 会话 ID 索引（重启恢复用）
const OVERRIDE_CHECK_MS = 5000              // override.json 热加载检查间隔
const CHAT_INDEX_TTL_MS = 30 * 24 * 3600 * 1000  // 索引条目 30 天未活跃则清理

// ===== 会话/项目管理（SPEC-wechat-session-mgmt.md M1）=====
const BINDINGS_FILENAME = 'bindings.json'  // 联系人 → 项目/会话绑定状态（持久化）
const DAILY_PROJECT_ID = '__daily__'       // 日常模式伪项目 ID
const MENU_TTL_MS = 5 * 60 * 1000          // 编号菜单有效期（内存态，重启丢失可接受）
const SESSIONS_PAGE_SIZE = 8               // /sessions 每页条数
const HISTORY_MAX_TURNS = 100              // 内存滚动对话历史上限（/history 用）
const HISTORY_MAX_SEGMENTS = 20            // /history 单次发送分段上限

// ===== Embedding 智能路由（SPEC 第 3 节，M2）=====
const ANCHORS_FILENAME = 'anchors.json'    // 项目锚点缓存（文本指纹 + 更新时间 / 向量）
const ANCHOR_TTL_MS = 60 * 60 * 1000       // 锚点缓存 1 小时
const ANCHOR_FILE_CHARS = 2000             // AGENTS.md / README.md 取前 N 字符
const ANCHOR_RECENT_TURNS = 6              // 锚点混入的最近对话轮数（K）
const ROUTE_SILENCE_MS = 60 * 1000         // 手动切换后路由静默窗口
const ROUTE_HYSTERESIS = 0.05              // 项目间切换迟滞（enter + 0.05）
const ROUTE_HTTP_TIMEOUT_MS = 4000         // embedding/搜索调用超时
const VIKING_SCHEME = 'viking:'            // OpenViking 虚拟路径前缀（避免与本地路径混淆）
const ROUTE_SUGGEST_WORDS = ['来', '继续', '开始', '搞定', '修', '写', '跑', '部署', '帮我', '处理', '检查', '更新', '发布', '构建', '测试', '安装', '配置', '重构', '优化', '排查']

/** 生成项目锚点文本：AGENTS.md/README.md 前 2000 字 + 最近 K 轮对话（若有）。 */
export function buildAnchorText(projectPath, recentTurns = []) {
  const bits = []
  for (const name of ['AGENTS.md', 'README.md', 'README.zh.md', 'readme.md']) {
    try {
      const file = join(projectPath, name)
      if (existsSync(file) && statSync(file).isFile()) {
        bits.push(readFileSync(file, 'utf8').slice(0, ANCHOR_FILE_CHARS))
        break // 只取第一个命中的文档
      }
    } catch { /* 读取失败跳过 */ }
  }
  if (recentTurns.length > 0) {
    bits.push(recentTurns.slice(-ANCHOR_RECENT_TURNS * 2).map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n').slice(0, ANCHOR_FILE_CHARS))
  }
  return bits.join('\n\n').trim() || basename(projectPath)
}

/** 工作意图启发式：祈使开头或含操作词（仅作建议触发，不影响投递）。 */
export function hasWorkIntent(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (ROUTE_SUGGEST_WORDS.some((w) => t.startsWith(w))) return true
  return /(\.js|\.ts|\.py|\.md|\.json|提交|编译|部署|命令行|终端|报错|bug|接口|数据库|git|npm|测试|文件|目录)/i.test(t)
}

/** 余弦相似度（deepseek provider 本地计算用）。 */
export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a?.length ?? 0, b?.length ?? 0)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 项目 ID → OpenViking 锚点文档 URI（内容写入 + 相似度搜索都定位到它）。 */
function anchorUriFor(projectId) {
  const hash = createHash('sha1').update(String(projectId)).digest('hex').slice(0, 12)
  return `${VIKING_SCHEME}//resources/wechat-plus-route/${hash}.md`
}

/** 联系人绑定状态（每联系人独立，持久化到 bindings.json）。 */
function loadBindings(stateDir) {
  try {
    const parsed = readJsonFile(join(stateDir, BINDINGS_FILENAME))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 首次运行 */ }
  return {}
}

/** 合并式保存（整文件写回，单联系人失败不影响其他）。 */
function saveBindingsFile(stateDir, bindings) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, BINDINGS_FILENAME), JSON.stringify(bindings, null, 2))
  } catch { /* 写失败不致命，仅失去重启恢复 */ }
}

/** 日常模式工作目录（不存在则创建）。 */
function dailyDir(ensure = false) {
  const dir = join(homedir(), '.dsh', 'daily')
  if (ensure && !existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* 创建失败时交给 agents.create 报错 */ }
  }
  return dir
}

/** /history 脱敏：API key / Bearer / 密码赋值 / 长随机串 / 手机号 → ***。 */
export function redactText(text) {
  let out = String(text ?? '')
  // 1) Bearer / token 头
  out = out.replace(/(bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi, '***')
  // 2) 密码/API key/token 赋值（key: value / key=value）——值遇中文/中文标点即停，不吞后续正文
  out = out.replace(/\b(api[-_]?key|apikey|secret|password|passwd|pwd|token|access[-_]?token)\b\s*[:=]\s*[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/gi, (m) => `${m.split(/[:=]/)[0]}=***`)
  // 3) sk- 开头的 API key
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '***')
  // 4) 长随机串（≥40 位的连续 base62/base64/十六进制串）
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, '***')
  // 5) 中国大陆手机号
  out = out.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '***')
  return out
}

/** 读取 UTF-8 JSON（容忍 BOM：用户可能用记事本等工具编辑过状态/覆盖文件）。 */
function readJsonFile(path) {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
}

/** 运行时覆盖配置：避开 DSH patch 重载缺陷，白名单/管理员可热调整。 */
function loadOverride(stateDir) {
  try {
    const parsed = readJsonFile(join(stateDir, OVERRIDE_FILENAME))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 无覆盖文件 */ }
  return {}
}

/** 联系人 → 会话 ID 的持久索引（重启后恢复上下文）。 */
function loadChatIndex(stateDir) {
  try {
    const parsed = readJsonFile(join(stateDir, CHAT_INDEX_FILENAME))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 首次运行 */ }
  return {}
}

function saveChatIndex(stateDir, index) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, CHAT_INDEX_FILENAME), JSON.stringify(index, null, 2))
  } catch { /* 索引写失败不致命，仅失去重启恢复能力 */ }
}

/** 简单文件日志（桌面应用里控制台不可见，落盘方便排查）。 */
export function makeFileLogger(stateDir) {
  const file = join(stateDir, 'bridge.log')
  const write = (level, ...parts) => {
    try {
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
      let body
      try { body = readFileSync(file, 'utf8') } catch { body = '' }
      const line = `[${new Date().toISOString()}] [${level}] ${parts.map((p) => typeof p === 'string' ? p : String(p)).join(' ')}\n`
      if (Buffer.byteLength(body) > MAX_LOG_BYTES) body = body.slice(body.length / 2)
      writeFileSync(file, body + line)
    } catch { /* 日志失败不影响主流程 */ }
  }
  return {
    info: (...p) => write('info', ...p),
    warn: (...p) => write('warn', ...p),
    error: (...p) => write('error', ...p)
  }
}

/** 把 ctx.logger 与文件日志合并，两边各写一份。 */
export function makeLogger(ctx, stateDir) {
  const file = makeFileLogger(stateDir)
  const mirror = (method, ...parts) => {
    const text = parts.map((p) => (p instanceof Error ? `${p.message}` : String(p))).join(' ')
    try { ctx.logger?.[method]?.(`[wechat-plus] ${text}`) } catch { /* ignore */ }
    file[method]?.(text)
  }
  return {
    info: (...p) => mirror('info', ...p),
    warn: (...p) => mirror('warn', ...p),
    error: (...p) => mirror('error', ...p)
  }
}

/** 状态文件：凭证、长轮询游标、最后登录时间。 */
function loadState(stateDir) {
  const file = join(stateDir, 'state.json')
  try {
    const parsed = readJsonFile(file)
    if (parsed && typeof parsed === 'object' && parsed.version === 1) return parsed
  } catch { /* 首次运行 */ }
  return { version: 1, credentials: null, syncBuf: '', lastLoginAt: 0 }
}

function saveState(stateDir, state) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2))
  } catch (error) {
    // 写状态失败不致命，但会导致每次重启都要重新扫码
    console.error(`[wechat-plus] 状态写入失败: ${error?.message ?? error}`)
  }
}

/** 把二维码内容渲染成 HTML 页面（页面自带自动刷新），按需在默认浏览器打开。
 *  内容可能是微信 liteapp 链接（用本地编码器生成二维码图）、图片 URL 或 base64。 */
async function renderQrPage(stateDir, log, qrContent, openInBrowser = true) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    let src = qrContent
    if (/^https?:\/\//i.test(qrContent)) {
      // 微信登录链接：本地生成二维码图片，手机微信扫码即可打开
      src = await qrcode.toDataURL(qrContent, { margin: 1, width: 320 })
    } else if (!/^data:image\//i.test(qrContent)) {
      // 假设是 base64 编码的图片内容
      src = `data:image/png;base64,${qrContent}`
    }
    const raw = String(qrContent).replace(/</g, '&lt;')
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="4"><title>DSH 微信桥接 - 扫码登录</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;background:#111;color:#eee;display:flex;
flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
h1{font-size:22px;font-weight:normal;margin:0 0 8px;}
p{color:#aaa;font-size:14px;margin:0 0 20px;text-align:center;line-height:1.8;}
img{width:300px;height:300px;background:#fff;border-radius:8px;padding:8px;}
a{color:#6af;word-break:break-all;max-width:640px;font-size:12px;margin-top:20px;text-align:center;}
</style></head><body>
<h1>DSH 微信桥接 · 扫码登录</h1>
<p>用手机微信扫描下方二维码（或把下方链接发到手机后点开）确认授权。<br>二维码约 60 秒过期，本页面每 4 秒自动刷新；扫码成功后即可关闭。</p>
<img src="${src}" alt="登录二维码">
<a href="${raw}">${raw}</a>
</body></html>`
    const file = join(stateDir, 'login.html')
    writeFileSync(file, html)
    if (openInBrowser) {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else {
        spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref()
      }
      log.info(`二维码页面已生成并尝试在浏览器打开：${file}`)
    } else {
      log.info('二维码已刷新（已打开的登录页会自动更新，无需重新打开）。')
    }
  } catch (error) {
    log.warn(`二维码页面生成失败，可复制下方原始链接到手机打开：\n${String(qrContent).slice(0, 500)}`)
  }
}

/** 把 content 数组（[{type:'text',text},…]）拼成纯文本。 */
function contentItemsText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (typeof c === 'string' ? c : String(c?.text ?? ''))).filter(Boolean).join('\n')
}

/** 提取一条 iLink 消息里的可用文字（文字消息或语音转写）。 */
function extractUsableText(msg) {
  const direct = WeChatClient.extractText(msg)
  if (direct && direct.trim()) return direct.trim()
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.VOICE && item.voice_item?.text && item.voice_item.text.trim()) {
      return item.voice_item.text.trim()
    }
  }
  return ''
}

/** 消息是否含有媒体（图片/文件/视频），用于给出不支持提示。 */
function hasMediaItem(msg) {
  return (msg.item_list ?? []).some((item) =>
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VIDEO)
}

/** 消息中的图片条目。 */
function imageItems(msg) {
  return (msg.item_list ?? []).filter((item) => item.type === MessageItemType.IMAGE)
}

/** 消息中的文件条目。 */
function fileItems(msg) {
  return (msg.item_list ?? []).filter((item) => item.type === MessageItemType.FILE)
}

/** 清洗文件名：去掉路径分隔与非法字符，防路径穿越。 */
function sanitizeFileName(name) {
  const base = String(name ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim()
  const cleaned = base.replace(/^\.+/, '')
  return cleaned.slice(0, 120) || 'file'
}

/** 工具注册要求的 output 声明：把 { content:[{type:'text',text}] } 渲染为模型可见文本。 */
function textToolOutput() {
  return {
    schema: {
      type: 'object',
      properties: { content: { type: 'array', items: {} } },
      required: ['content'],
      additionalProperties: false
    },
    render(_args, value) {
      const text = (value?.content ?? [])
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('')
        .trim()
      return [{ type: 'text', text: text || '(无输出)' }]
    }
  }
}

/** 按文件头魔数推断图片扩展名。 */
function guessImageExtension(data) {
  if (!data || data.length < 4) return '.jpg'
  if (data[0] === 0xff && data[1] === 0xd8) return '.jpg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return '.webp'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif'
  return '.jpg'
}

/** 定时任务最近触发时间（重启后不重复触发同一分钟）。 */
function loadJobState(stateDir) {
  try {
    const parsed = readJsonFile(join(stateDir, 'jobs-state.json'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 首次运行 */ }
  return {}
}

function saveJobState(stateDir, state) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'jobs-state.json'), JSON.stringify(state, null, 2))
  } catch { /* 忽略 */ }
}

const URL_ONLY = /^\s*(https?:\/\/\S+)(\s+https?:\/\/\S+)*\s*$/i

/** 默认微信客户端实现（测试可整体替换）。 */
let defaultClientFactory = WeChatClient

/** 测试专用：替换默认微信客户端实现（集成测试注入 FakeClient）。 */
export function setClientFactoryForTests(factory) {
  defaultClientFactory = factory
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

const HELP_TEXT = `【DSH 微信助手】使用说明：
• 直接发消息，AI 会处理并流式回复
• /projects 查看项目列表（含"日常"）
• /project <n> 切换到第 n 个项目
• /sessions [页码/关键词] 列当前项目会话，回复数字切换
• /home 回到日常模式
• /new 当前项目另开新会话（旧会话可从 /sessions 找回）
• /stay [小时] 钉住当前上下文（默认 2h，无参=查询）
• /models 查看可用模型列表
• /model <编号|名称> 切换模型（无参=查看当前）
• /history [n] 查看最近 n 轮对话（默认 5，自动脱敏）
• /stop 停止当前任务
• /status 查看当前状态
• /help 显示本说明
安全提示：纯链接消息默认不处理；机器人只做消息中转。
控制命令仅管理员可用。`

/** 命令表：trim 后以 / 开头且首 token 完全匹配才拦截，其余（含未知 /xxx）走 AI。 */
const KNOWN_COMMANDS = [
  '/help', '/new', '/stop', '/status',
  '/projects', '/project', '/sessions', '/home', '/stay', '/history',
  '/models', '/model'
]

/** 把一段文本按 maxChars 切块（尽量在换行处断开）。 */
function splitForSend(text, maxChars) {
  if (text.length <= maxChars) return [text]
  const parts = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut <= 0) cut = maxChars
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * 桥接主类：管理凭证、长轮询、每个联系人的 Agent 会话与流式回传。
 * clientFactory 供测试注入模拟微信客户端（默认使用真实 wechat-ilink-client）。
 */
export class WeChatBridge {
  /**
   * 一次性迁移：旧插件（dsh-wechat-bridge）的 ~/.dsh/wechat-bridge 状态目录
   * 若存在且新目录尚无数据，则整体改名迁移到新目录，保留 token/索引/绑定等状态。
   * 任何失败都只记日志并继续用新目录（旧数据留在原地，不删除）。
   */
  static migrateLegacyStateDir(newDir) {
    const legacy = join(resolveDshHome(), 'wechat-bridge')
    try {
      if (!existsSync(legacy) || existsSync(newDir)) return newDir
      renameSync(legacy, newDir)
    } catch (error) {
      console.error(`[wechat-plus] 旧状态目录迁移失败（继续使用新目录）: ${error?.message ?? error}`)
    }
    return newDir
  }

  constructor(ctx, config, log, clientFactory = defaultClientFactory) {
    this.ctx = ctx
    this.config = config
    this.log = log ?? makeLogger(ctx, join(resolveDshHome(), 'wechat-plus'))
    this.clientFactory = clientFactory
    this.stateDir = WeChatBridge.migrateLegacyStateDir(join(resolveDshHome(), 'wechat-plus'))
    this.state = loadState(this.stateDir)
    this.chats = new Map()       // key -> chat 记录
    this.seen = new Set()        // 已处理消息 id
    this.client = null
    this.phase = 'idle'          // idle | login | running
    this.disposed = false
    this.ticker = null
    this.monitorTask = null
    this.retryTimer = null
    this.lastPollAt = 0          // 最近一次长轮询 poll 事件时间（假死看门狗用）
    this.attachedClients = new WeakSet()
    this.lockPath = join(this.stateDir, 'bridge.lock')
    this.lockOwned = false
    this.lastLockBeat = 0
    // v3：运行时覆盖配置 + 会话索引（重启恢复）
    this.override = loadOverride(this.stateDir)
    this.overrideMtime = 0
    this.lastOverrideCheck = 0
    this.chatIndex = loadChatIndex(this.stateDir)
    // v5：项目/会话绑定状态（每联系人独立，持久化）
    // this.bindings = loadBindings(this.stateDir)  // 改为惰性加载：见 getBinding（允许测试重指 stateDir 后再加载）
    this.menus = new Map()       // chatKey → 活跃编号菜单（内存态，5 分钟 TTL）
    // v4：定时任务
    this.jobState = loadJobState(this.stateDir)
    this.jobRuntime = new Map()
    this.jobsBoundTo = null
    this.lastOutboxScan = 0
    this.toolDisposers = []    // 本插件注册的 ctx.tools 工具的注销函数
    this.sendFailures = new Map() // outbox 发送失败计数（连续失败上限防刷屏）
  }

  /** 某联系人的文件回传目录（AI 把文件存这里即自动发送）。 */
  outboxDirFor(key) {
    return join(this.resolveWorkDir(), 'wechat-outbox', String(key).replace(/[^A-Za-z0-9._-]/g, '_'))
  }

  /** 在 Agent 的作用域内注册文件回传说明（仅该 Agent 可见）。 */
  setupAgentScope(agentCtx, chatKey) {
    if (this.config.outbox === false) return
    try {
      const systemPrompt = agentCtx.get('systemPrompt')
      const dir = this.outboxDirFor(chatKey)
      systemPrompt?.section({
        name: 'wechat-outbox',
        order: 400,
        text: `[微信文件回传] 用户向你要"文件"（HTML 报告、文档、表格、数据文件等）时，用工具 wechat_send_file（直接写入文件内容）或 wechat_send_local_file（发送工作目录里已有的文件）交付，文件会自动发送到用户微信，不要只把文件内容当文本贴在聊天里。也可以直接把文件保存到目录：${dir}，同样会自动发送。`
      })
    } catch { /* 注册失败不影响主流程 */ }
  }

  /** 由工具调用方（Agent）定位对应的微信会话对象。 */
  chatForCaller(agent) {
    const sessionId = String(agent?.session?.id ?? '')
    if (!sessionId) return null
    for (const chat of this.chats.values()) {
      if (!chat.tornDown && chat.sessionId != null && String(chat.sessionId) === sessionId) return chat
    }
    return null
  }

  /** 把文本内容写入联系人的 outbox 目录（随后由 scanOutboxes 自动发送）。 */
  async deliverFile(chat, filename, content) {
    const dir = this.outboxDirFor(chat.key)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = sanitizeFileName(filename)
    const file = join(dir, `wechat-send-${Date.now()}-${name}`)
    writeFileSync(file, String(content ?? ''), 'utf8')
    this.log.info(`工具 wechat_send_file 已写入：${file}`)
    return { file, name }
  }

  /** 把工作目录内的本地文件加入联系人的 outbox 队列（随后自动发送）。 */
  async deliverLocalFile(chat, pathText) {
    const workDir = resolve(this.resolveWorkDir())
    const target = resolve(isAbsolute(pathText) ? pathText : join(workDir, pathText))
    // 安全边界：只允许发送工作目录内的文件（防外发工作区外的任意文件）
    if (target !== workDir && !target.startsWith(workDir + sep)) {
      throw new Error('只允许发送工作目录内的文件。')
    }
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error('文件不存在或不是普通文件。')
    const dir = this.outboxDirFor(chat.key)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = sanitizeFileName(basename(target))
    const file = join(dir, `wechat-send-${Date.now()}-${name}`)
    copyFileSync(target, file)
    this.log.info(`工具 wechat_send_local_file 已入队：${file}`)
    return { file, name }
  }

  /** 注册微信桥接专属工具（全局注册，不依赖 Agent 预设组合，微信侧智能体必然可见）。 */
  registerTools(ctx) {
    if (!ctx?.tools?.register) return
    const mkDisposer = (def) => {
      try { return ctx.tools.register(def) } catch (error) {
        this.log.warn(`工具注册失败（${def.name}）：${error?.message ?? error}`)
        return null
      }
    }
    const d1 = mkDisposer({
      name: 'wechat_send_file',
      description: '把内容保存为文件并自动发送到当前微信用户（微信桥接专用）。当用户要求"生成/给我一个文件、报告、文档、HTML、表格、数据文件"时，优先调用本工具直接交付文件，而不是把内容当文本贴在聊天里。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名（含扩展名，如 report.html、数据表.csv）' },
          content: { type: 'string', description: '文件完整内容（UTF-8 文本）。二进制文件请改用 wechat_send_local_file。' }
        },
        required: ['filename', 'content'],
        additionalProperties: false
      },
      output: textToolOutput(),
      execute: async (args, exec) => {
        const chat = this.chatForCaller(exec?.agent)
        if (!chat) throw new Error('当前会话未关联微信联系人，无法发送文件。')
        const done = await this.deliverFile(chat, String(args?.filename ?? 'file.txt'), String(args?.content ?? ''))
        return { content: [{ type: 'text', text: `已把「${done.name}」写入微信回传队列，稍后会自动发送到用户微信。` }] }
      }
    })
    if (d1) this.toolDisposers.push(d1)
    const d2 = mkDisposer({
      name: 'wechat_send_local_file',
      description: '把工作目录里已有的本地文件（图片、PDF、Office、压缩包等）发送到当前微信用户（微信桥接专用）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径，或相对工作目录的路径）' }
        },
        required: ['path'],
        additionalProperties: false
      },
      output: textToolOutput(),
      execute: async (args, exec) => {
        const chat = this.chatForCaller(exec?.agent)
        if (!chat) throw new Error('当前会话未关联微信联系人，无法发送文件。')
        const done = await this.deliverLocalFile(chat, String(args?.path ?? ''))
        return { content: [{ type: 'text', text: `已把「${done.name}」加入微信回传队列，稍后会自动发送到用户微信。` }] }
      }
    })
    if (d2) this.toolDisposers.push(d2)
    this.log.info(`已注册微信专属工具：${this.toolDisposers.length} 个（wechat_send_file / wechat_send_local_file）。`)
  }

  /**
   * 上传本地文件到微信 CDN（AES-128-ECB 加密）。
   * 兼容 getUploadUrl 的两种响应：新版 `upload_full_url`（预签名完整地址）与
   * 旧版 `upload_param`+filekey。下载参数取自 CDN 响应头 `x-encrypted-param`。
   * （wechat-ilink-client@0.1.0 只认旧字段，服务端已切新字段，故在此自实现上传段。）
   */
  async uploadToWeChatCdn(filePath, toUserId, mediaType = UploadMediaType.FILE) {
    // 大小上限：50MB 以上文件不做内存整读，直接拒绝（微信文件消息一般远小于此）
    const fileStat = statSync(filePath)
    if (fileStat.size > 50 * 1024 * 1024) {
      throw new Error(`文件 ${basename(filePath)} 超过 50MB，暂不支持回传。`)
    }
    const plaintext = readFileSync(filePath)
    const rawsize = plaintext.length
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
    const filesize = aesEcbPaddedSize(rawsize)
    const filekey = randomBytes(16).toString('hex')
    const aeskey = randomBytes(16)
    const resp = await this.client.api.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex')
    })
    const fullUrl = String(resp?.upload_full_url ?? '').trim()
    const cdnUrl = fullUrl || (resp?.upload_param
      ? buildCdnUploadUrl({ cdnBaseUrl: this.client.api.cdnBaseUrl, uploadParam: resp.upload_param, filekey })
      : '')
    if (!cdnUrl) throw new Error(`getUploadUrl 未返回可用上传地址：${JSON.stringify(resp).slice(0, 200)}`)
    const ciphertext = encryptAesEcb(plaintext, aeskey)
    let downloadParam = ''
    let lastError = null
    for (let attempt = 1; attempt <= 3 && !downloadParam; attempt++) {
      try {
        let res
        if (typeof this.client.uploadCdn === 'function') {
          // 测试注入口：模拟 CDN 上传（集成测试用 FakeClient）
          const fake = await this.client.uploadCdn(cdnUrl, ciphertext)
          downloadParam = fake?.downloadParam ?? ''
        } else {
          res = await fetch(cdnUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext)
          })
          if (!res.ok) throw new Error(`CDN 上传失败（HTTP ${res.status}）`)
          downloadParam = res.headers.get('x-encrypted-param') ?? ''
        }
        if (!downloadParam && attempt < 3) { lastError = new Error('CDN 响应缺少 x-encrypted-param'); await this.sleep(1000) }
      } catch (error) {
        lastError = error
        if (attempt < 3) await this.sleep(1000)
      }
    }
    if (!downloadParam) throw lastError ?? new Error('CDN 上传失败')
    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawsize,
      fileSizeCiphertext: filesize
    }
  }

  /** 扫描各会话的 outbox 目录，把新文件发到微信并移入 sent/。 */
  async scanOutboxes() {
    if (!this.client || this.phase !== 'running') return
    for (const chat of this.chats.values()) {
      const dir = this.outboxDirFor(chat.key)
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const file = join(dir, entry.name)
        const sentDir = join(dir, 'sent')
        try {
          if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true })
          const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name)
          const uploaded = await this.uploadToWeChatCdn(file, chat.to, isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE)
          // 发给微信时去掉内部前缀（wechat-send-<时间戳>-），保留原始文件名
          const displayName = entry.name.replace(/^wechat-send-\d+-/, '') || entry.name
          if (isImage) {
            await this.client.sendUploadedImage(chat.to, uploaded, undefined, chat.contextToken || '')
          } else {
            await this.client.sendUploadedFile(chat.to, displayName, uploaded, undefined, chat.contextToken || '')
          }
          renameSync(file, join(sentDir, entry.name))
          this.sendFailures.delete(file)
          this.log.info(`已回传文件（${chat.isGroup ? `群 ${chat.to}` : `联系人 ${chat.to}`}）：${entry.name}`)
        } catch (error) {
          // 连续失败上限：避免每 2 秒重试刷屏；超过 5 次移入 failed/ 停止重试
          this.sendFailures ??= new Map()
          const fails = (this.sendFailures.get(file) ?? 0) + 1
          this.sendFailures.set(file, fails)
          if (fails >= 5) {
            this.sendFailures.delete(file)
            const failedDir = join(dir, 'failed')
            try {
              if (!existsSync(failedDir)) mkdirSync(failedDir, { recursive: true })
              renameSync(file, join(failedDir, entry.name))
              this.log.warn(`文件回传连续失败 ${fails} 次，已移入 failed/：${entry.name}`)
            } catch { /* 移动失败忽略 */ }
          } else {
            this.log.warn(`文件回传失败（${entry.name}，第 ${fails} 次）：${error?.message ?? error}`)
          }
        }
      }
    }
  }

  /** 生效的消息白名单（override.json 优先于 patch 配置）。 */
  effectiveAllowFrom() {
    if (Array.isArray(this.override.allowFrom) && this.override.allowFrom.length > 0) return this.override.allowFrom
    return this.config.allowFrom ?? ['*']
  }

  /** 生效的管理员列表（override.json 优先）。 */
  effectiveAdmins() {
    if (Array.isArray(this.override.admins)) return this.override.admins
    return this.config.admins ?? []
  }

  /** 检查并热加载 override.json（约 5 秒一次，按 mtime 判断变化）。 */
  refreshOverride() {
    const now = Date.now()
    if (now - this.lastOverrideCheck < OVERRIDE_CHECK_MS) return
    this.lastOverrideCheck = now
    try {
      const path = join(this.stateDir, OVERRIDE_FILENAME)
      if (!existsSync(path)) {
        // 文件被删除：回退到 patch 配置
        if (this.overrideMtime !== 0 || Object.keys(this.override).length > 0) {
          this.overrideMtime = 0
          this.override = {}
          this.log.info('override.json 已移除，恢复使用 patch 配置。')
        }
        return
      }
      const mtime = statSync(path).mtimeMs
      if (mtime === this.overrideMtime) return
      this.overrideMtime = mtime
      const next = loadOverride(this.stateDir)
      this.override = next
      this.log.info(`已热加载 override.json：allowFrom=${JSON.stringify(this.effectiveAllowFrom())}，admins=${JSON.stringify(this.effectiveAdmins())}，jobs=${(Array.isArray(next.jobs) ? next.jobs : []).length} 个。`)
    } catch { /* 读取失败保留旧值 */ }
  }

  /** 定时任务配置（override.json 热加载）。 */
  effectiveJobs() {
    return Array.isArray(this.override.jobs) ? this.override.jobs : []
  }

  /** 定时任务运行态同步（override 变化后重建）。 */
  syncJobs() {
    if (this.jobsBoundTo === this.override) return
    this.jobsBoundTo = this.override
    this.jobRuntime = new Map()
    for (const job of this.effectiveJobs()) {
      if (!job || typeof job !== 'object' || typeof job.cron !== 'string' || typeof job.prompt !== 'string') {
        this.log.warn(`定时任务配置无效（缺少 cron/prompt）：${JSON.stringify(job)}`)
        continue
      }
      const parsed = parseCron(job.cron)
      if (!parsed) {
        this.log.warn(`定时任务 cron 表达式无效：${job.cron}`)
        continue
      }
      const id = job.id ?? `job-${this.jobRuntime.size}`
      // 修复：首次加载（无历史记录）不立即补跑，从"下一次 cron 时刻"开始
      const lastRun = this.jobState[id] ?? Date.now()
      const nextRun = nextCronAfter(parsed, lastRun)
      this.jobRuntime.set(id, { job, parsed, nextRun })
    }
  }

  /** 检查并触发到期的定时任务。 */
  checkJobs(now) {
    this.syncJobs()
    if (this.jobRuntime.size === 0) return
    for (const [id, entry] of this.jobRuntime) {
      if (entry.nextRun == null || now < entry.nextRun) continue
      this.jobState[id] = now
      saveJobState(this.stateDir, this.jobState)
      entry.nextRun = nextCronAfter(entry.parsed, now)
      this.fireJob(id, entry.job).catch((error) => this.log.error(`定时任务执行异常（${id}）：${error?.stack ?? error?.message ?? error}`))
    }
  }

  /** 执行一个定时任务：给目标联系人派活（回复经正常流式链路回传）。 */
  async fireJob(id, job) {
    const to = job.to
    if (!to) {
      this.log.warn(`定时任务 ${id} 缺少目标联系人（to），跳过。`)
      return
    }
    // 安全：任务目标必须是管理员（防止配置被篡改后骚扰他人）
    const admins = this.effectiveAdmins()
    if (admins.length > 0 && !admins.includes(to)) {
      this.log.warn(`定时任务 ${id} 的目标 ${to} 不是管理员，已拒绝。`)
      return
    }
    if (!this.client || this.phase !== 'running') {
      this.log.warn(`定时任务 ${id} 触发时客户端未就绪，跳过本次。`)
      return
    }
    const key = `u:${to}`
    const chat = this.ensureChat(key, to)
    try {
      await this.ensureAgentFor(chat)
    } catch (error) {
      this.log.error(`定时任务 ${id} 创建/恢复 Agent 失败：${error?.message ?? error}`)
      return
    }
    // 任务推送前先点亮"正在输入…"，让用户有感知
    this.setTyping(chat, true).catch(() => {})
    chat.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[定时任务] ${job.prompt}` }],
      source: { kind: 'user' }
    }))
    this.log.info(`定时任务 ${id} 已触发：给 ${to} 派活「${truncate(job.prompt, 40)}」。`)
  }

  /** 目标 PID 是否存活（跨实例/跨进程锁检测）。 */
  static pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /** 抢占单例锁：已有一个健康实例在跑时返回 false。 */
  acquireSingleton() {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      const lock = readJsonFile(this.lockPath)
      if (lock && typeof lock === 'object') {
        const fresh = Date.now() - (lock.heartbeat ?? 0) < 90000
        if (WeChatBridge.pidAlive(lock.pid) && fresh) return false
      }
    } catch { /* 无锁或锁损坏 → 抢占 */ }
    return this.writeLock()
  }

  /** 写入/刷新锁。 */
  writeLock() {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), heartbeat: Date.now() }))
      return true
    } catch {
      return true // 锁写不了也继续运行（单机场景）
    }
  }

  /** 释放锁（仅当锁属于自己）。 */
  releaseSingleton() {
    if (!this.lockOwned) return
    this.lockOwned = false
    try { unlinkSync(this.lockPath) } catch { /* 忽略 */ }
  }

  /** 绑定入站消息/错误/过期事件（每个 client 只绑定一次）。 */
  attachListeners(client) {
    if (this.attachedClients.has(client)) return
    this.attachedClients.add(client)
    client.on('message', (msg) => { this.onMessage(msg).catch((e) => this.log.error(`消息处理异常：${e?.message ?? e}`)) })
    client.on('error', (e) => this.log.warn(`iLink 客户端错误：${e?.message ?? e}`))
    client.on('poll', () => { this.lastPollAt = Date.now() })
    client.on('sessionExpired', () => {
      this.log.warn('凭证已过期，稍后自动重新扫码。')
      try { client.stop() } catch { /* 已停止则忽略 */ }
      this.state.credentials = null
      saveState(this.stateDir, this.state)
      this.client = null
      this.phase = 'login'
    })
  }

  /** 决定当前应使用的凭证：配置 > 已保存状态。 */
  currentCredentials() {
    if (this.config.token) {
      return {
        token: this.config.token,
        accountId: this.config.accountId || this.state.credentials?.accountId || '',
        baseUrl: this.config.baseUrl || DEFAULT_BASE_URL
      }
    }
    return this.state.credentials
  }

  /** 计算 Agent 工作目录：配置 > DSH 工作区 > 用户主目录。 */
  resolveWorkDir() {
    if (this.config.workDir) return this.config.workDir
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const first = registry?.list?.()[0]
      const path = first?.path ?? first?.record?.path
      if (path) return path
    } catch { /* 忽略 */ }
    return homedir()
  }

  // ===== 会话/项目管理（M1）=====

  /** 取某联系人的绑定状态（不存在则给默认：日常模式 + 空指针）。绑定惰性加载（跟随 stateDir）。 */
  getBinding(chat) {
    this.bindings ??= loadBindings(this.stateDir)
    const existing = this.bindings[chat.key]
    if (existing && typeof existing === 'object' && typeof existing.projectId === 'string') {
      existing.sessionByProject ??= {}
      existing.stayUntil ??= null
      existing.model ??= null
      return existing
    }
    const fresh = { projectId: DAILY_PROJECT_ID, sessionByProject: {}, stayUntil: null }
    this.bindings[chat.key] = fresh
    return fresh
  }

  /** 持久化绑定状态（合并式：整个 bindings 对象写回）。 */
  persistBindings() {
    this.bindings ??= loadBindings(this.stateDir)
    saveBindingsFile(this.stateDir, this.bindings)
  }

  /** 当前项目列表：日常置顶 + workspaceRegistry 里的项目。 */
  listProjects() {
    const projects = [{ id: DAILY_PROJECT_ID, label: '日常', path: dailyDir(false) }]
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const entries = registry?.list?.() ?? []
      for (const entry of entries) {
        const path = entry?.path ?? entry?.record?.path
        if (!path || typeof path !== 'string') continue
        if (projects.some((p) => p.path === path)) continue
        const name = entry?.name ?? entry?.record?.name ?? basename(path)
        projects.push({ id: path, label: name || basename(path), path })
      }
    } catch { /* registry 取不到时只剩"日常" */ }
    return projects
  }

  /** workspaceRegistry 是否可用（不可用时项目类命令降级提示）。 */
  hasWorkspaceRegistry() {
    try { return Boolean(this.ctx.get('workspaceRegistry')?.list) } catch { return false }
  }

  /** sessionQuery 服务（不可用时 /sessions、/history 相关查询降级）。
   *  真实服务方法：searchSessions({query, sessionFilters, eventFilters, cursor?}) → {items, nextCursor}，
   *  兼容 mock 场景的 listSessions()。 */
  getSessionQuery() {
    try {
      const q = this.ctx.get('sessionQuery')
      if (q && (typeof q.searchSessions === 'function' || typeof q.listSessions === 'function')) return q
      return null
    } catch { return null }
  }

  /** 兼容两种取会话列表的方式：searchSessions（真实 DSH）与 listSessions（mock/旧版）。
   *  真实 searchSessions 是全文搜索接口：query 必须非空（空串会抛 SessionQueryError 使 DSH 崩溃），
   *  也没有"列出全部"语义。这里用一组常见高频词轮询近似全列，并用 cwd 过滤器收敛到目标项目；
   *  任何查询异常都被捕获并返回部分/空结果，绝不让错误穿透到 DSH 进程。 */
  async allSessionRecords(projectPath) {
    const query = this.getSessionQuery()
    if (!query) return null // null = 服务不可用（与空列表区分）
    if (typeof query.searchSessions !== 'function') {
      const raw = await query.listSessions()
      const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.sessions ?? [])
      return items.map((item) => ({ header: item?.header ?? item, title: item?.title ?? item?.header?.title ?? null }))
    }
    // 真实 DSH：cwd 过滤 + 多个高频查询词轮询（FTS 只能按内容匹配，无法纯列表）。
    // 常见会话内容几乎都会包含这些通用词之一；每个词最多拉 10 页/200 条防失控。
    const probeTerms = ['a', 'the', '和', '我', '你', '1', 'e', '了', '在', '是', 'to', '的']
    const cwdFilter = projectPath ? [{ kind: 'cwd', values: [projectPath] }] : []
    const seen = new Map()
    for (const term of probeTerms) {
      if (seen.size >= 200) break
      let cursor
      try {
        for (let page = 0; page < 10 && seen.size < 200; page++) {
          const result = await query.searchSessions({
            query: term,
            sessionFilters: cwdFilter,
            eventFilters: [],
            limit: 100,
            ...(cursor === undefined ? {} : { cursor })
          })
          const items = result?.items ?? []
          for (const item of items) {
            const header = item?.header ?? item
            const id = String(header?.id ?? item?.id ?? '')
            if (!id || seen.has(id)) continue
            seen.set(id, { header, title: item?.title ?? header?.title ?? null })
          }
          cursor = result?.nextCursor
          if (cursor === undefined || cursor === null) break
        }
      } catch (error) {
        // 单个查询词失败（含 SessionQueryError）不致命：跳过该词继续
        this.log.warn?.(`会话列表查询词「${term}」失败（忽略）：${error?.message ?? error}`)
      }
    }
    return [...seen.values()]
  }

  /** 列出某项目（按 header.cwd 精确匹配）下的会话，按创建/更新时间倒序。条目：{id,title,updatedAt}。
   *  标题优先级：DSH 标题服务（readTitleSnapshots）> 记录自带 title > 首条用户消息截断 > 未命名。 */
  async listProjectSessions(projectPath) {
    const records = await this.allSessionRecords(projectPath)
    if (records === null) return null
    const mapped = []
    for (const record of records) {
      const header = record.header ?? {}
      const cwd = header.cwd ?? record.cwd
      if (!cwd || cwd !== projectPath) continue
      const id = header.id ?? record.id
      if (id == null) continue
      mapped.push({
        id: String(id),
        title: truncate(String(record.title ?? header.title ?? ''), 24),
        updatedAt: Number(header.updatedAt ?? header.createdAt ?? record.updatedAt ?? 0) || 0
      })
    }
    mapped.sort((a, b) => b.updatedAt - a.updatedAt)
    // searchSessions 的 title 是 FTS 事件摘录而非会话标题，全部弃用；
    // 统一走 DSH 标题服务（readTitleSnapshots 内部会加载持久化日志 fold 标题事件，
    // 等价于浏览器"点击激活"会话后标题可见），无标题会话再读事件流取首条用户消息兜底。
    // 标题服务可用时（真实 DSH）：清空 searchSessions 的摘录式 title，统一以水合结果为准
    const q = this.getSessionQuery()
    if (q && typeof q.readTitleSnapshots === 'function') {
      for (const s of mapped) s.title = ''
    }
    await this.hydrateTitles(mapped)
    for (const s of mapped) if (!s.title) s.title = '未命名会话'
    return mapped
  }

  /** 为会话列表水合真实标题：①readTitleSnapshots 批量（结果形态 {status,value:{session,title}}）
   *  ②仍无标题的（最多前 12 个）读事件流取首条用户消息截断兜底。全部 try/catch 静默降级。 */
  async hydrateTitles(sessions) {
    const query = this.getSessionQuery()
    try {
      if (query && typeof query.readTitleSnapshots === 'function') {
        const results = await query.readTitleSnapshots(sessions.map((s) => s.id))
        const list = Array.isArray(results) ? results : []
        for (const r of list) {
          const value = r?.value ?? (r?.title || r?.session ? r : null)
          if (!value) continue
          const id = String(value.session?.id ?? r?.sessionId ?? '')
          // 真实形态：value.title 是 SessionTitleSnapshot 对象 {title, source, …}，取其 .title 字符串；
          // 兼容纯字符串形态。空值过滤在 String() 之前做，避免 "[object Object]"。
          const rawTitle = value.title
          const title = typeof rawTitle === 'string' ? rawTitle : (typeof rawTitle?.title === 'string' ? rawTitle.title : '')
          const hit = id ? sessions.find((s) => s.id === id) : null
          if (hit && title) hit.title = truncate(title, 24)
        }
      }
    } catch (error) {
      this.log.warn?.(`批量取会话标题失败（忽略）：${error?.message ?? error}`)
    }
    // 标题服务也没有的（从未生成标题的会话）：读事件流用首条用户消息兜底（限前 12 个防拖慢列表）
    for (const s of sessions.filter((x) => !x.title).slice(0, 12)) {
      try {
        if (query && typeof query.listEvents === 'function') {
          const events = await query.listEvents(s.id)
          const first = Array.isArray(events)
            ? events.map((r) => r?.event ?? r).find((e) => e?.type === 'user/message')
            : null
          const text = contentItemsText(first?.data?.content)
          if (text) s.title = truncate(text.replace(/\s+/g, ' '), 24)
        }
      } catch { /* 单个会话兜底失败忽略 */ }
    }
  }

  /** 从会话记录里查某会话的 header（cwd / title）。 */
  async findSessionRecord(sessionId) {
    const records = await this.allSessionRecords(undefined)
    if (records === null) return null
    for (const record of records) {
      const header = record.header ?? {}
      const id = header.id ?? record.id
      if (id != null && String(id) === String(sessionId)) return { cwd: header.cwd ?? null, title: record.title ?? header.title ?? null }
    }
    return null
  }

  /** resume 时 meta.cwd 强制取该会话 header 的 cwd（阶层约束铁律）。 */
  async sessionHeaderCwd(sessionId) {
    try {
      return (await this.findSessionRecord(sessionId))?.cwd ?? null
    } catch { return null }
  }

  /** 会话标题（从记录里找；找不到返回 null）。 */
  async sessionTitle(sessionId) {
    try {
      return (await this.findSessionRecord(sessionId))?.title ?? null
    } catch { return null }
  }

  /** 绑定对应的工作目录（日常 → ~/.dsh/daily/ 并确保存在）。 */
  projectCwdFor(binding) {
    if (binding.projectId === DAILY_PROJECT_ID) return dailyDir(true)
    const project = this.listProjects().find((p) => p.id === binding.projectId)
    return project ? project.path : this.resolveWorkDir()
  }

  /** 项目显示名。 */
  projectLabel(projectId) {
    if (projectId === DAILY_PROJECT_ID) return '日常'
    const project = this.listProjects().find((p) => p.id === projectId)
    return project ? project.label : truncate(projectId, 24)
  }

  // ===== /model /models 模型切换（M5）=====

  /** 某联系人的模型选择：绑定里的 /model 覆盖（持久化）优先，否则全局默认选择。 */
  modelSelectionFor(chat) {
    let selection
    try {
      const defaultModel = this.ctx.get('agentDefaultModel')
      selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
    } catch { /* 服务不可用时只用联系人覆盖 */ }
    const binding = this.getBinding(chat)
    if (binding.model?.model) {
      return { provider: binding.model.provider || selection?.provider, model: binding.model.model }
    }
    return selection
  }

  /** llm 服务（不可用时 /models、/model 降级提示）。 */
  getLlm() {
    try {
      const llm = this.ctx.get('llm')
      return llm && typeof llm.listModels === 'function' ? llm : null
    } catch { return null }
  }

  /** 列出全部可用模型：[{provider, model}]，按 provider 分组顺序展开。
   *  返回 null = llm 服务不可用；某 provider 失败（无凭据等）跳过该组并记日志。 */
  async listAllModels() {
    const llm = this.getLlm()
    if (!llm) return null
    let providers = []
    try {
      providers = (typeof llm.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []) ?? []
    } catch { /* 老版本服务：无 provider 列表 */ }
    const out = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider)
        for (const m of models ?? []) {
          if (m?.id) out.push({ provider: String(provider), model: String(m.id) })
        }
      } catch (error) {
        this.log.warn(`列出 ${provider} 的模型失败（跳过该组）：${error?.message ?? error}`)
      }
    }
    return out
  }

  /** 切换当前联系人的模型（写入绑定持久化，重启保留；下一条消息起生效）。 */
  async switchModel(chat, provider, model) {
    const binding = this.getBinding(chat)
    const before = this.modelSelectionFor(chat)
    const old = before?.model || '默认'
    binding.model = { provider: String(provider), model: String(model) }
    this.persistBindings()
    chat.model = String(model)
    let note = ''
    if (chat.agent) {
      if (chat.busy) {
        note = '\n当前任务运行中（未中断），本任务仍用旧模型，其后的新对话起生效。'
      } else {
        // 拆掉空闲 agent：下一条消息 resume 同一会话（上下文保留）并带上新模型选择
        await this.teardownChat(chat, { keepIndex: true })
        note = '\n下一条消息起生效（会话上下文保留）。'
      }
    }
    this.log.info(`联系人 ${chat.to} 切换模型：${old} → ${model}（provider ${provider}）。`)
    await this.reply(chat, `模型已切换：${old} → ${model}${note}`)
  }

  /** 取活跃菜单（过期自动删除并返回 null）。 */
  activeMenu(chat) {
    const menu = this.menus.get(chat.key)
    if (!menu) return null
    if (Date.now() > menu.expiresAt) {
      this.menus.delete(chat.key)
      return null
    }
    return menu
  }

  /** 设置/刷新菜单（单活跃：新菜单出现即作废旧菜单）。 */
  setMenu(chat, menu) {
    this.menus.set(chat.key, { ...menu, expiresAt: Date.now() + MENU_TTL_MS })
  }

  /** 切换项目：落最近活跃会话（无则指针置空，下一条消息自动新建）。
   *  options.silent：不发"已切换"回复（自动路由用，由调用方发自己的标头）。
   *  所有切换（手动/自动）都会刷新路由静默窗口（60s 内路由器不对抗用户）。 */
  async switchProject(chat, projectId, options = {}) {
    const binding = this.getBinding(chat)
    this.routeSilentUntil = Math.max(this.routeSilentUntil ?? 0, Date.now() + ROUTE_SILENCE_MS)
    if (binding.projectId === projectId) {
      if (!options.silent) await this.reply(chat, `已在【${this.projectLabel(projectId)}】中。`)
      return
    }
    let busyNote = ''
    if (chat.agent && chat.busy) busyNote = '\n注意：当前会话有任务运行中（未中断）。'
    await this.teardownChat(chat, { keepIndex: true })
    binding.projectId = projectId
    binding.sessionByProject ??= {}
    let sid = binding.sessionByProject[projectId] ?? null
    // 没有指针时尝试落在该项目的最近活跃会话
    if (!sid) {
      let sessions = null
      try {
        sessions = await this.listProjectSessions(projectId === DAILY_PROJECT_ID ? dailyDir(false) : projectId)
      } catch (error) {
        this.log.warn?.(`切换项目时会话查询失败（忽略，按空处理）：${error?.message ?? error}`)
      }
      if (sessions === null) {
        if (!options.silent) await this.reply(chat, `已切换到【${this.projectLabel(projectId)}】（会话查询不可用，新消息将新建会话）。${busyNote}`)
        this.persistBindings()
        return
      }
      sid = sessions[0]?.id ?? null
      binding.sessionByProject[projectId] = sid
    }
    this.persistBindings()
    // 同步 chatIndex（保持与旧机制兼容）
    this.chatIndex[chat.key] = { ...(this.chatIndex[chat.key] ?? {}), lastActive: Date.now() }
    if (sid) this.chatIndex[chat.key].sessionId = sid
    else delete this.chatIndex[chat.key].sessionId
    saveChatIndex(this.stateDir, this.chatIndex)
    let title = ''
    if (sid) {
      const t = await this.sessionTitle(sid)
      if (t) title = `，落在《${truncate(String(t), 24)}》`
    }
    if (!options.silent) {
      await this.reply(chat, `已切换到【${this.projectLabel(projectId)}】${title || '（下一条消息将新建会话）'}。${busyNote ? busyNote.trim() : ''}`.trim())
    }
    return { sessionId: sid, title }
  }

  /** 切换当前项目下的会话（不杀运行中任务，仅提示）。手动切换刷新路由静默窗口。 */
  async switchSession(chat, sessionId, title) {
    this.routeSilentUntil = Math.max(this.routeSilentUntil ?? 0, Date.now() + ROUTE_SILENCE_MS)
    const binding = this.getBinding(chat)
    let busyNote = ''
    if (chat.agent && chat.busy) busyNote = '\n注意：当前会话有任务运行中（未中断）。'
    await this.teardownChat(chat, { keepIndex: true })
    binding.sessionByProject ??= {}
    binding.sessionByProject[binding.projectId] = sessionId
    this.persistBindings()
    this.chatIndex[chat.key] = { ...(this.chatIndex[chat.key] ?? {}), sessionId, lastActive: Date.now() }
    saveChatIndex(this.stateDir, this.chatIndex)
    await this.reply(chat, `已切换：《${title}》${busyNote}`)
  }

  /** 生成（或复用）某项目的锚点。openviking：文本写入 OpenViking 锚点文档（服务端向量化）；
   *  deepseek：本地算向量存 anchors.json。均带 1h TTL。 */

  // ===== Embedding 智能路由（M2，SPEC 第 3 节）=====

  /** 路由是否启用（总开关 + provider + routeMode 三重条件）。 */
  routerActive() {
    return this.config.routerEnabled === true &&
      String(this.config.routerProvider ?? 'openviking') !== 'off' &&
      String(this.config.routeMode ?? 'auto') !== 'off'
  }

  /** 可注入的 HTTP POST（测试替换 fetchImpl；生产用全局 fetch + 超时）。 */
  async httpPostJson(url, body, headers = {}) {
    const doFetch = this.fetchImpl ?? fetch
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROUTE_HTTP_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  /** 载入锚点缓存（anchors.json，内存懒加载）。 */
  loadAnchors() {
    this.anchorCache ??= (() => {
      try {
        const parsed = readJsonFile(join(this.stateDir, ANCHORS_FILENAME))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch { /* 首次 */ }
      return {}
    })()
    return this.anchorCache
  }

  saveAnchors() {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      writeFileSync(join(this.stateDir, ANCHORS_FILENAME), JSON.stringify(this.loadAnchors(), null, 2))
    } catch { /* 缓存写失败只影响性能 */ }
  }

  /** 生成（或复用）某项目的锚点。openviking：文本写入 OpenViking 锚点文档（服务端向量化）；
   *  deepseek：本地算向量存 anchors.json。均带 1h TTL；文本未变只刷新时间戳。 */
  async ensureAnchor(project) {
    const anchors = this.loadAnchors()
    const entry = anchors[project.id]
    // 最近 K 轮对话取自内存滚动历史（当前联系人）
    const recent = this.chats.get(this.currentRouteChatKey ?? '')?.history ?? []
    const anchorText = buildAnchorText(project.path, recent)
    const textHash = createHash('sha1').update(anchorText).digest('hex')
    if (entry && entry.textHash === textHash) return entry // 文本没变直接复用（含向量）
    if (entry && Date.now() - entry.updatedAt < ANCHOR_TTL_MS && entry.textHash != null) return entry // TTL 内不重算
    const provider = String(this.config.routerProvider ?? 'openviking')
    const updated = { updatedAt: Date.now(), textHash }
    if (provider === 'openviking') {
      // 写入 OpenViking 锚点文档。实测（0.4.15）：新文件需 mode=create（已存在用 replace），
      // 且 wait=true 也不等于完成向量化 —— 必须再显式 reindex（vectors_only）才能被 find 检索。
      const uri = anchorUriFor(project.id)
      const base = this.config.routerOpenvikingBaseUrl
      const payload = { uri, content: `# 项目锚点：${project.label}\n${anchorText}` }
      try {
        await this.httpPostJson(`${base}/api/v1/content/write`, { ...payload, mode: 'create' })
      } catch (error) {
        // 已存在（409/ALREADY_EXISTS）→ 改 replace 覆盖；其他错误向上抛（调用方降级直通）
        if (/409|ALREADY_EXISTS/i.test(String(error?.message ?? error))) {
          await this.httpPostJson(`${base}/api/v1/content/write`, { ...payload, mode: 'replace' })
        } else {
          throw error
        }
      }
      await this.httpPostJson(`${base}/api/v1/content/reindex`, { uri })
    } else if (provider === 'deepseek') {
      updated.vector = await this.deepseekEmbed(anchorText)
    } else {
      throw new Error(`未知 routerProvider：${provider}`)
    }
    anchors[project.id] = updated
    this.saveAnchors()
    return updated
  }

  /** deepseek provider：OpenAI 兼容 embeddings 接口。 */
  async deepseekEmbed(text) {
    const key = String(this.config.routerDeepseekApiKey ?? '')
    if (!key) throw new Error('routerDeepseekApiKey 未配置')
    const body = { input: String(text).slice(0, 4000) }
    if (this.config.routerDeepseekModel) body.model = this.config.routerDeepseekModel
    const data = await this.httpPostJson(`${this.config.routerDeepseekBaseUrl}/embeddings`, body, { Authorization: `Bearer ${key}` })
    const vec = data?.data?.[0]?.embedding
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('embeddings 响应缺少向量')
    return vec
  }

  /** openviking provider：find(query, target_uri=锚点) 的 score 即相似度（服务端向量化）。 */
  async openvikingSimilarity(query, projectId) {
    const project = this.listProjects().find((p) => p.id === projectId)
    if (project) await this.ensureAnchor(project)
    const data = await this.httpPostJson(`${this.config.routerOpenvikingBaseUrl}/api/v1/search/find`, {
      query: String(query).slice(0, 1000), target_uri: anchorUriFor(projectId), limit: 1
    })
    const result = data?.result ?? {}
    let best = 0
    for (const group of [result.memories, result.resources, result.skills]) {
      for (const item of group ?? []) {
        if (typeof item?.score === 'number') best = Math.max(best, item.score)
      }
    }
    return best
  }

  /** 计算消息与各项目的相似度，降序返回 [{projectId,label,score}]。任何失败抛错由调用方降级。 */
  async projectSimilarities(text) {
    const projects = this.listProjects().filter((p) => p.id !== DAILY_PROJECT_ID)
    if (projects.length === 0) return []
    const provider = String(this.config.routerProvider ?? 'openviking')
    const scored = []
    if (provider === 'openviking') {
      for (const project of projects) {
        scored.push({ projectId: project.id, label: project.label, score: await this.openvikingSimilarity(text, project.id) })
      }
    } else {
      // deepseek：消息向量与各锚点向量本地余弦
      const msgVec = await this.deepseekEmbed(text)
      for (const project of projects) {
        const anchor = await this.ensureAnchor(project)
        scored.push({ projectId: project.id, label: project.label, score: cosine(msgVec, anchor.vector) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored
  }

  /**
   * 消息投递前的路由钩子（M1 留下的判断点，M2 实现）。
   * 返回 null = 按当前绑定指针投递（路由内部的切换通过 switchProject 直接改绑定）。
   * 决策表见 SPEC 第 3 节；provider 失败 → 降级直通（永不阻塞消息）。
   */
  async routeMessage(chat, text) {
    if (!this.routerActive()) return null
    const binding = this.getBinding(chat)
    // stayUntil 钉住 / 手动切换后的静默窗口：路由器闭嘴
    if (binding.stayUntil && binding.stayUntil > Date.now()) return null
    if ((this.routeSilentUntil ?? 0) > Date.now()) return null
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return null

    let sims
    try {
      this.currentRouteChatKey = chat.key // ensureAnchor 取滚动历史用
      sims = await this.projectSimilarities(trimmed)
    } catch (error) {
      // 降级：不路由，消息按当前指针投递；限频记日志防刷屏
      const now = Date.now()
      if (now - (this.lastRouteFailLog ?? 0) > 60000) {
        this.lastRouteFailLog = now
        this.log.warn(`路由相似度计算失败，本轮降级直通：${error?.message ?? error}`)
      }
      return null
    }
    if (sims.length === 0) return null
    const margin = Number(this.config.routerMargin) || 0.08
    const enter = Number(this.config.routerEnter) || 0.62
    const top1 = sims[0]
    const top2 = sims[1] ?? null
    const routeMode = String(this.config.routeMode ?? 'auto')

    if (binding.projectId === DAILY_PROJECT_ID) {
      // 在日常：判是否切入项目
      if (top1.score < enter) return null // 都低 → 留日常
      const ambiguous = top2 && (top1.score - top2.score) - margin <= 1e-9 // 浮点容差：差恰好 = margin 视为歧义（<= 语义）
      if (ambiguous || routeMode === 'ask') {
        // 三选一菜单：1.【A】 2.【B】 3.留日常（消息本身留在日常投递）
        const items = [...sims.slice(0, 2).map((s) => ({ projectId: s.projectId, label: s.label })), { stay: true, label: '留日常' }]
        this.setMenu(chat, { kind: 'route-choice', items })
        const lines = items.map((it, i) => `${i + 1}. ${it.stay ? '留日常' : `【${it.label}】`}`).join('  ')
        await this.reply(chat, `这条消息像哪个项目的活？${lines}\n（回复数字选择）`)
        return null
      }
      // 高置信自动切入（含标头 + 可撤销提示）
      const switched = await this.switchProject(chat, top1.projectId, { silent: true })
      const title = switched?.title ? `·《${truncate(String(switched.title), 24)}》` : ''
      await this.reply(chat, `[已进入【${top1.label}】${title}]\n↩ /home 回日常`)
      return null // 绑定已切，ensureAgentFor 按新指针投递
    }

    // 在项目 A：只做"切出建议"，绝不静默切走（项目里允许闲聊）
    const current = sims.find((s) => s.projectId === binding.projectId)
    const other = sims.find((s) => s.projectId !== binding.projectId)
    if (current && other && other.score > enter + ROUTE_HYSTERESIS && other.score > current.score + margin && hasWorkIntent(trimmed)) {
      // 建议菜单：1.切过去 2.就在这聊（消息照常投给当前项目）
      this.setMenu(chat, { kind: 'route-suggest', items: [{ projectId: other.projectId, label: other.label }, { stay: true, label: '就在这聊' }] })
      await this.reply(chat, `这像【${other.label}】的活？1.切过去  2.就在这聊`)
    }
    return null
  }

  /** 滚动历史（内存）：记录一条用户/AI 消息。 */
  pushHistory(chat, role, text) {
    chat.history ??= []
    chat.history.push({ role, text: String(text ?? '') })
    if (chat.history.length > HISTORY_MAX_TURNS * 2) chat.history = chat.history.slice(-HISTORY_MAX_TURNS * 2)
  }

  /** 启动：有凭证直接进入运行态，否则走扫码登录。 */
  async start() {
    // 单例互斥：发现另一个健康实例时自动停用（防止双实例抢消息、回复交错）
    if (this.config.singleton !== false) {
      this.lockOwned = this.acquireSingleton()
      if (!this.lockOwned) {
        this.log.warn('检测到另一个微信桥接实例正在运行（bridge.lock），本实例自动停用。')
        this.disposed = true
        return
      }
      this.lastLockBeat = Date.now()
    }
    // 优先使用 Cordis 的 ctx.setInterval（随 fiber 自动清理），否则退回全局定时器
    if (typeof this.ctx.setInterval === 'function') {
      this.ticker = this.ctx.setInterval(() => this.tick(), TICK_MS)
    } else {
      this.ticker = setInterval(() => this.tick(), TICK_MS)
      this.ticker.unref?.()
    }
    const creds = this.currentCredentials()
    if (creds?.token) {
      this.log.info(`使用已有凭证启动（账号 ${creds.accountId || '未知'}）。`)
      this.phase = 'running'
      this.lastPollAt = Date.now()
    } else {
      this.log.info('未找到凭证，进入扫码登录流程。')
      this.phase = 'login'
    }
    this.monitorTask = this.monitorLoop().catch((error) => this.log.error(`运行循环异常：${error?.message ?? error}`))
  }

  /** 扫码登录：生成二维码页面 → 轮询确认 → 保存凭证。 */
  async loginFlow() {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL
    const loginClient = new this.clientFactory({ baseUrl })
    // 每次登录尝试只在首个二维码时弹浏览器；后续刷新只更新页面内容（页面自带自动刷新）
    let opened = false
    const result = await loginClient.login({
      timeoutMs: 8 * 60 * 1000,
      onQRCode: async (qr) => {
        await renderQrPage(this.stateDir, this.log, qr, !opened)
        opened = true
      },
      onStatus: (status) => this.log.info(`扫码状态：${status}`)
    })
    if (!result.connected) throw new Error(result.message || '扫码登录未完成')
    this.state.credentials = {
      token: result.botToken,
      accountId: result.accountId ?? '',
      baseUrl: result.baseUrl || baseUrl,
      userId: result.userId ?? ''
    }
    this.state.lastLoginAt = Date.now()
    saveState(this.stateDir, this.state)
    this.log.info(`扫码登录成功：账号 ${this.state.credentials.accountId || '未知'}，扫码人 ${result.userId || '未知'}（可加入 allowFrom 白名单）。`)
    const client = new this.clientFactory({
      token: result.botToken,
      accountId: result.accountId ?? '',
      baseUrl: result.baseUrl || baseUrl
    })
    this.attachListeners(client)
    return client
  }

  /** 主循环：登录（如需）→ 长轮询监听，失败按冷却时间重试。 */
  async monitorLoop() {
    while (!this.disposed) {
      if (this.phase === 'running') {
        if (!this.client) {
          // 凭证还在但 client 没建（例如过期重登后）
          const creds = this.currentCredentials()
          if (creds?.token) {
            this.client = new this.clientFactory({
              token: creds.token,
              accountId: creds.accountId || '',
              baseUrl: creds.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL
            })
            this.attachListeners(this.client)
          } else {
            this.phase = 'login'
            continue
          }
        }
        const client = this.client
        try {
          this.log.info('开始接收微信消息…')
          await client.start({
            longPollTimeoutMs: 25000,
            loadSyncBuf: () => this.state.syncBuf || '',
            saveSyncBuf: (buf) => {
              this.state.syncBuf = buf
              saveState(this.stateDir, this.state)
            }
          })
        } catch (error) {
          this.log.warn(`长轮询中断：${error?.message ?? error}`)
        }
        if (this.disposed) return
        if (this.phase === 'running') {
          // 意外中断且凭证仍在：冷却后重连
          await this.sleep(this.config.loginCooldownSecs * 1000)
        }
        continue
      }
      // phase === 'login'
      try {
        this.log.info('开始扫码登录（二维码页面即将打开）…')
        this.client = await this.loginFlow()
        this.phase = 'running'
      } catch (error) {
        this.log.warn(`登录失败：${error?.message ?? error}，${this.config.loginCooldownSecs} 秒后重试。`)
        await this.sleep(this.config.loginCooldownSecs * 1000)
      }
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.retryTimer = setTimeout(resolve, ms)
    })
  }

  /** 入站消息统一入口（EventEmitter 回调，异步执行）。 */
  async onMessage(msg) {
    if (this.disposed || !msg || msg.message_type !== MessageType.USER) return
    const isGroup = Boolean(msg.group_id)
    if (isGroup && !this.config.groups) {
      // 群聊功能关闭：只记日志，避免在群里刷屏
      this.log.info(`收到群消息（群聊功能未开启，已忽略）：group=${msg.group_id}`)
      return
    }
    const userId = msg.from_user_id
    if (!userId) return

    // 白名单按发送者校验（群里每个成员都按自己的身份过滤）
    const allow = this.effectiveAllowFrom()
    if (!allow.includes('*') && !allow.includes(userId)) {
      this.log.info(`非白名单联系人消息已忽略：${userId}`)
      return
    }

    // 去重（同一消息可能被长轮询重复投递）
    const dedupeKey = msg.message_id ?? `${userId}:${msg.create_time_ms ?? 0}:${msg.item_list?.length ?? 0}`
    if (dedupeKey != null && this.seen.has(dedupeKey)) return
    this.seen.add(dedupeKey)
    if (this.seen.size > SEEN_CAP) {
      const it = this.seen.values().next().value
      if (it !== undefined) this.seen.delete(it)
    }

    const text = extractUsableText(msg)
    if (isGroup) {
      // 群聊：仅响应 @机器人 的消息。协议 @ 格式未公开，先按账号 ID/本地名/"@" 开头
      // 匹配，并记诊断日志（含原始字段），实测后可据此修正。
      this.log.info(`群消息诊断：group=${msg.group_id} from=${userId} to=${msg.to_user_id ?? '?'} 内容=${truncate(text.replace(/\n/g, ' '), 60)}`)
      if (!this.isGroupMentioned(text)) return
      if (this.config.blockLinks && text && URL_ONLY.test(text.trim())) {
        this.log.info(`已拦截群内纯链接消息（group=${msg.group_id} from=${userId}）。`)
        return
      }
    }

    const key = isGroup ? `g:${msg.group_id}` : `u:${userId}`
    const chat = this.ensureChat(key, isGroup ? msg.group_id : userId)
    chat.isGroup = isGroup
    chat.from = userId
    chat.contextToken = msg.context_token ?? chat.contextToken
    chat.lastActive = Date.now()
    // 即时反馈：消息一收到就点亮微信"正在输入…"（群聊无此能力，跳过）
    if (!isGroup) this.setTyping(chat, true).catch(() => {})
    // 持久化上下文令牌：重启后定时任务才能主动发消息
    // （首条消息时索引可能还没有条目，先建再写）
    const indexEntry = this.chatIndex[key] ?? (this.chatIndex[key] = {})
    if (msg.context_token && indexEntry.contextToken !== msg.context_token) {
      indexEntry.contextToken = msg.context_token
      indexEntry.lastActive = Date.now()
      saveChatIndex(this.stateDir, this.chatIndex)
    }

    // 串行化单个联系人的操作，避免 /new、/stop 与普通消息竞态
    chat.opQueue = chat.opQueue.then(() => this.handleInbound(chat, msg))
  }

  /** 群聊消息是否 @ 了机器人（兼容：完整账号 ID、本地名、"@" 开头）。 */
  isGroupMentioned(text) {
    if (!this.config.groupRequireMention) return true
    const t = String(text ?? '').trim()
    if (!t) return false
    const account = String(this.state.credentials?.accountId ?? this.config.accountId ?? '').trim()
    if (account && t.includes(account)) return true
    const local = account.split('@')[0]
    if (local && t.includes(local)) return true
    if (t.startsWith('@')) return true
    return false
  }

  ensureChat(key, userId) {
    let chat = this.chats.get(key)
    // 正在拆除的会话（/new 后的旧对象）不复用，保证新消息拿到全新对象
    if (!chat || chat.tornDown) {
      chat = {
        key,
        to: userId,
        tornDown: false,
        // 优先取持久化的上下文令牌（定时任务主动发消息需要）
        contextToken: this.chatIndex[key]?.contextToken ?? '',
        agent: null,
        handle: null,
        sessionId: null,
        buffer: '',
        footer: '',
        lastSeq: 0,
        busy: false,
        lastActive: Date.now(),
        lastFlush: 0,
        opQueue: Promise.resolve()
      }
      this.chats.set(key, chat)
    }
    return chat
  }

  /** 处理一条已过白名单的消息：命令或普通转发。 */
  async handleInbound(chat, msg) {
    if (this.disposed) return
    // 本对象可能已被 /new 或空闲回收拆除（排队期间发生）：改走当前活跃会话对象
    if (chat.tornDown || this.chats.get(chat.key) !== chat) {
      chat = this.ensureChat(chat.key, chat.to)
      chat.isGroup = Boolean(msg.group_id)
      chat.from = msg.from_user_id
      chat.contextToken = msg.context_token ?? chat.contextToken
      chat.lastActive = Date.now()
    }
    const text = extractUsableText(msg)

    const trimmed = text.trim()
    // 编号菜单回复：有活跃菜单（或刚过期）时，纯数字优先按菜单选择处理
    if (/^\d+$/.test(trimmed)) {
      const menu = this.menus.get(chat.key)
      if (menu) {
        if (Date.now() > menu.expiresAt) {
          this.menus.delete(chat.key)
          await this.reply(chat, '菜单已失效，请重新 /sessions')
          return
        }
        await this.handleMenuSelection(chat, Number(trimmed))
        return
      }
      // 无菜单：纯数字按普通消息走 AI
    }
    // 会话菜单翻页：活跃 sessions 菜单时，裸 n = 下一页（与页脚提示一致）
    if (trimmed.toLowerCase() === 'n') {
      const menu = this.menus.get(chat.key)
      if (menu?.kind === 'sessions' && !menu.keyword && Date.now() <= menu.expiresAt) {
        await this.showSessionsMenu(chat, 'n')
        return
      }
    }
    // 命令拦截：trim 后以 / 开头且首 token 在命令表（完全匹配），其余（含未知 /xxx）走 AI
    const firstToken = trimmed.toLowerCase().split(/\s+/)[0]
    if (trimmed.startsWith('/') && KNOWN_COMMANDS.includes(firstToken)) {
      await this.handleCommand(chat, trimmed)
      return
    }

    if (!text) {
      if (hasMediaItem(msg)) {
        const hasUnsupported = (msg.item_list ?? []).some((item) => item.type === MessageItemType.VIDEO)
        if (hasUnsupported) {
          await this.reply(chat, '视频暂未开放；图片和文件可以直接发。')
        }
        // 纯图片/纯文件消息：走下方下载处理（text 为空时仍转发路径）
      }
      if (!imageItems(msg).length && !fileItems(msg).length) return
    }

    // 安全铁律：纯链接不自动处理
    if (text && this.config.blockLinks && URL_ONLY.test(text)) {
      this.log.info(`已拦截纯链接消息（来自 ${chat.to}）。`)
      await this.reply(chat, '【安全提示】纯链接消息不自动处理，已拦截。请用文字描述你的需求。')
      return
    }

    // 微信图片：下载到工作目录，把路径交给 AI 用工具读取分析
    let imageNote = ''
    const images = imageItems(msg)
    if (images.length > 0) {
      try {
        const dir = join(this.resolveWorkDir(), 'wechat-attachments')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const saved = []
        let index = 0
        for (const item of images) {
          const media = await this.client.downloadMedia(item)
          if (!media?.data) continue
          const ext = guessImageExtension(media.data)
          const file = join(dir, `wechat-img-${Date.now()}-${index++}${ext}`)
          writeFileSync(file, media.data)
          saved.push(file)
          this.log.info(`微信图片已保存：${file}（${media.data.length} 字节）`)
        }
        if (saved.length > 0) {
          imageNote = `\n\n[微信图片] 用户刚发来 ${saved.length} 张图片，已保存到本地：\n${saved.join('\n')}\n请读取并分析这些图片（可用 OCR、python、图片查看等工具），然后回复用户。`
          await this.reply(chat, `📷 收到 ${saved.length} 张图片，正在分析…`)
        }
      } catch (error) {
        this.log.error(`图片下载失败：${error?.stack ?? error?.message ?? error}`)
        await this.reply(chat, '⚠️ 图片下载失败，请重试或改用文字描述。')
        return
      }
    }

    // 微信文件：下载到工作目录，把路径交给 AI 用工具读取分析
    let fileNote = ''
    const files = fileItems(msg)
    if (files.length > 0) {
      try {
        const dir = join(this.resolveWorkDir(), 'wechat-attachments')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const saved = []
        let index = 0
        for (const item of files) {
          const media = await this.client.downloadMedia(item)
          if (!media?.data) continue
          const name = sanitizeFileName(media.fileName || item.file_item?.file_name || 'file')
          const file = join(dir, `wechat-file-${Date.now()}-${index++}-${name}`)
          writeFileSync(file, media.data)
          saved.push({ file, name, bytes: media.data.length })
          this.log.info(`微信文件已保存：${file}（${media.data.length} 字节）`)
        }
        if (saved.length > 0) {
          fileNote = `\n\n[微信文件] 用户刚发来 ${saved.length} 个文件，已保存到本地：\n${saved.map((s) => `${s.file}（文件名：${s.name}，${s.bytes} 字节）`).join('\n')}\n请读取并分析这些文件，然后回复用户。`
          await this.reply(chat, `📎 收到 ${saved.length} 个文件（${saved.map((s) => s.name).join('、')}），正在分析…`)
        }
      } catch (error) {
        this.log.error(`文件下载失败：${error?.stack ?? error?.message ?? error}`)
        await this.reply(chat, '⚠️ 文件下载失败，请重试。')
        return
      }
    }

    // 路由钩子（M2 插槽）：消息投递给 agent 之前；M1 默认直通
    const routed = await this.routeMessage(chat, text || '')

    // 记录滚动历史（内存态，/history 用；只记纯文字，媒体消息略过）
    if (text) this.pushHistory(chat, 'user', text)

    // 确保有 Agent（优先恢复绑定指针指向的会话；/new 后或首次消息时新建）
    if (!chat.agent) {
      try {
        await this.ensureAgentFor(chat, routed)
      } catch (error) {
        this.log.error(`创建/恢复 Agent 失败：${error?.stack ?? error?.message ?? error}`)
        await this.reply(chat, `⚠️ AI 启动失败：${truncate(error?.message ?? String(error), 120)}`)
        return
      }
    }

    try {
      const content = [{ type: 'text', text: text || `用户发来媒体消息（无文字）${imageNote || fileNote ? '' : '，但下载失败'}` }]
      if (imageNote) content[0].text += imageNote
      if (fileNote) content[0].text += fileNote
      chat.agent.followup(createUserMessage({
        content,
        source: { kind: 'user' }
      }))
      const mediaDesc = [images.length ? `${images.length} 图` : '', files.length ? `${files.length} 文件` : ''].filter(Boolean).join('，')
      this.log.info(`已转发消息给 AI（${chat.isGroup ? `群 ${chat.to} 成员 ${chat.from}` : `联系人 ${chat.to}`}，${(text || '').length} 字${mediaDesc ? `，${mediaDesc}` : ''}）。`)
    } catch (error) {
      this.log.error(`消息入队失败：${error?.message ?? error}`)
      await this.reply(chat, `⚠️ 消息处理失败：${truncate(error?.message ?? String(error), 120)}`)
    }
  }

  /** 确保联系人有可用 Agent：优先恢复绑定指针指向的会话，否则新建。
   *  routed（routeMessage 返回值，M2 用）可强制指定会话；M1 恒为 null。 */
  async ensureAgentFor(chat, routed = null) {
    const binding = this.getBinding(chat)
    let sid = binding.sessionByProject?.[binding.projectId] ?? null
    if (routed?.sessionId) sid = routed.sessionId
    let resumed = false
    if (sid) {
      resumed = await this.tryResumeAgentFor(chat, sid)
      if (resumed) binding.sessionByProject[binding.projectId] = sid
    }
    if (!resumed) await this.createAgentFor(chat)
  }

  /** 为某个联系人创建独立的 DSH Agent 会话（cwd 取当前绑定项目目录；模型取联系人覆盖或全局默认）。 */
  async createAgentFor(chat) {
    const agents = this.ctx.get('agents')
    const selection = this.modelSelectionFor(chat)
    const binding = this.getBinding(chat)
    const sessionId = SessionId(`wechat-${randomUUID()}`)
    const options = {
      sessionId,
      meta: { cwd: this.projectCwdFor(binding) }
    }
    if (selection?.provider && selection?.model) {
      options.agentOptions = { provider: selection.provider, model: selection.model }
      // 注意：agent-loop 会对 setup 的返回值调用 ?.commit()（事务提交语义），
      // 因此这里必须用块体写法返回 undefined（与 dsh-headless 的用法一致），
      // 不能把 installModelSelection 的 disposer 作为返回值传出去。
      options.setup = (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        this.setupAgentScope(agentCtx, chat.key)
      }
    }
    const { agent, dispose } = await agents.create(options)
    chat.agent = agent
    chat.handle = { dispose }
    chat.sessionId = sessionId
    chat.model = selection?.model || ''
    chat.lastSeq = agent.session.seq
    chat.buffer = ''
    chat.footer = ''
    chat.busy = false
    chat.sanitizer = createStreamSanitizer()
    // 持久化联系人 → 会话索引（重启后恢复上下文）；合并式保存，保留已有的 contextToken
    this.chatIndex[chat.key] = { ...(this.chatIndex[chat.key] ?? {}), sessionId: String(sessionId), lastActive: Date.now() }
    saveChatIndex(this.stateDir, this.chatIndex)
    // 绑定指针同步（权威源）：新会话即为当前项目的当前会话
    const binding2 = this.getBinding(chat)
    binding2.sessionByProject[binding2.projectId] = String(sessionId)
    this.persistBindings()
    this.log.info(`已为联系人 ${chat.to} 创建会话 ${String(sessionId)}（项目【${this.projectLabel(binding2.projectId)}】）。`)
  }

  /** 恢复联系人上一次的持久化会话；失败（无持久化/损坏/冲突）返回 false。模型同样走联系人覆盖。 */
  async tryResumeAgentFor(chat, sessionId) {
    try {
      const agents = this.ctx.get('agents')
      const selection = this.modelSelectionFor(chat)
      const options = { resumeSessionId: SessionId(sessionId) }
      // 阶层约束铁律：resume 时 meta.cwd 强制取该会话 header 的 cwd，不做跨项目 resume。
      // 查得到 header.cwd 就显式带上（防上层默认值改写）；查不到则不传，交给 agents 用会话自身 cwd。
      const headerCwd = await this.sessionHeaderCwd(sessionId)
      if (headerCwd) options.meta = { cwd: headerCwd }
      if (selection?.provider && selection?.model) {
        options.agentOptions = { provider: selection.provider, model: selection.model }
        // 与 create 一致：块体写法返回 undefined（agent-loop 对返回值调用 ?.commit()）
        options.setup = (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          this.setupAgentScope(agentCtx, chat.key)
        }
      }
      const { agent, dispose } = await agents.resume(options)
      chat.agent = agent
      chat.handle = { dispose }
      chat.sessionId = sessionId
      chat.model = selection?.model || ''
      chat.lastSeq = agent.session.seq
      chat.buffer = ''
      chat.footer = ''
      chat.busy = false
      chat.sanitizer = createStreamSanitizer()
      // 合并式保存，保留 onMessage 刚写入的 contextToken（此前会被覆盖丢失）
      this.chatIndex[chat.key] = { ...(this.chatIndex[chat.key] ?? {}), sessionId, lastActive: Date.now() }
      saveChatIndex(this.stateDir, this.chatIndex)
      this.log.info(`已为联系人 ${chat.to} 恢复会话 ${sessionId}（上下文延续）。`)
      return true
    } catch (error) {
      this.log.warn(`会话恢复失败（联系人 ${chat.to}，${sessionId}）：${error?.message ?? error}，将新建会话。`)
      return false
    }
  }

  /** 斜杠命令。控制命令按管理员列表鉴权。 */
  async handleCommand(chat, trimmed) {
    // 即时反馈：命令处理期间发微信原生「正在输入…」状态（快速命令也无害，结束即撤）
    if (!chat.isGroup) this.setTyping(chat, true).catch(() => {})
    try {
      await this.handleCommandInner(chat, trimmed)
    } finally {
      if (!chat.isGroup) this.setTyping(chat, false).catch(() => {})
    }
  }

  async handleCommandInner(chat, trimmed) {
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0].toLowerCase()
    const arg = parts.slice(1).join(' ').trim()
    const CONTROL_COMMANDS = ['/new', '/stop', '/status', '/projects', '/project', '/sessions', '/home', '/stay', '/history', '/models', '/model']
    if (CONTROL_COMMANDS.includes(cmd)) {
      const admins = this.effectiveAdmins()
      // 群聊命令按发送者（chat.from）鉴权，私聊 chat.from 与 chat.to 相同
      const operator = chat.from ?? chat.to
      const isAdmin = admins.length === 0 || admins.includes(operator)
      if (!isAdmin) {
        this.log.warn(`非管理员 ${operator} 尝试执行控制命令：${cmd}，已拒绝。`)
        await this.reply(chat, '该命令仅管理员可用。')
        return
      }
    }
    switch (cmd) {
      case '/help':
        await this.reply(chat, HELP_TEXT)
        break
      case '/new': {
        this.log.info(`联系人 ${chat.to} 请求另开新会话。`)
        const binding = this.getBinding(chat)
        let busyNote = ''
        if (chat.agent && chat.busy) busyNote = '\n注意：当前会话有任务运行中（未中断）。'
        await this.teardownChat(chat, { keepIndex: true })
        // 只移动指针，不清数据：旧会话仍可从 /sessions 找回
        binding.sessionByProject[binding.projectId] = null
        this.persistBindings()
        if (this.chatIndex[chat.key]) {
          delete this.chatIndex[chat.key].sessionId
          saveChatIndex(this.stateDir, this.chatIndex)
        }
        await this.reply(chat, `已在【${this.projectLabel(binding.projectId)}】另开新会话（旧会话可从 /sessions 找回）。下一条消息开始新话题。${busyNote}`)
        break
      }
      case '/stop': {
        if (chat.agent && chat.busy) {
          chat.agent.cancel({ kind: 'user' })
          await this.reply(chat, '已请求停止当前任务。')
        } else {
          await this.reply(chat, '当前没有正在执行的任务。')
        }
        break
      }
      case '/status': {
        const binding = this.getBinding(chat)
        const agentState = chat.agent ? String(chat.agent.status ?? 'unknown') : '无会话'
        const busyText = chat.busy ? '（忙）' : ''
        const sid = binding.sessionByProject?.[binding.projectId] ?? chat.sessionId
        let sessionInfo = '会话：新会话待创建'
        if (sid) {
          const title = await this.sessionTitle(sid)
          sessionInfo = title ? `会话：《${truncate(String(title), 24)}》` : `会话：${String(sid).slice(0, 12)}…`
        }
        let stayInfo = '钉住：无'
        if (binding.stayUntil && binding.stayUntil > Date.now()) {
          stayInfo = `钉住：剩 ${Math.ceil((binding.stayUntil - Date.now()) / 60000)} 分钟`
        } else if (binding.stayUntil) {
          binding.stayUntil = null
          this.persistBindings()
        }
        const modelInfo = `模型：${chat.model || this.modelSelectionFor(chat)?.model || '默认'}`
        await this.reply(chat, `【状态】\n项目：${this.projectLabel(binding.projectId)}\n${sessionInfo}\n${modelInfo}\n${stayInfo}\nAgent：${agentState}${busyText}\n/projects 看项目，/sessions 看会话，/models 换模型，/new 另开新会话。`)
        break
      }
      case '/projects': {
        const projects = this.listProjects()
        if (projects.length <= 1 && !this.hasWorkspaceRegistry()) {
          await this.reply(chat, '当前 DSH 版本不支持项目查询（仅日常模式可用）。')
          break
        }
        const binding = this.getBinding(chat)
        const lines = projects.map((p, i) => {
          const cur = p.id === binding.projectId ? ' ✓当前' : ''
          return `${i + 1}. ${p.label}${cur}`
        })
        this.setMenu(chat, { kind: 'projects', items: projects })
        await this.reply(chat, `【项目列表】\n${lines.join('\n')}\n回复数字切换，或用 /project <n>。`)
        break
      }
      case '/project': {
        const n = Number(arg)
        if (!Number.isInteger(n) || n < 1) {
          await this.reply(chat, '用法：/project <编号>（编号见 /projects）。')
          break
        }
        const projects = this.listProjects()
        if (n > projects.length) {
          await this.reply(chat, `编号超出范围（共 ${projects.length} 个项目，见 /projects）。`)
          break
        }
        await this.switchProject(chat, projects[n - 1].id)
        break
      }
      case '/sessions':
        await this.showSessionsMenu(chat, arg)
        break
      case '/home':
        await this.switchProject(chat, DAILY_PROJECT_ID)
        break
      case '/stay': {
        const binding = this.getBinding(chat)
        if (!arg) {
          if (binding.stayUntil && binding.stayUntil > Date.now()) {
            await this.reply(chat, `当前上下文已钉住，剩 ${Math.ceil((binding.stayUntil - Date.now()) / 60000)} 分钟。`)
          } else {
            await this.reply(chat, '当前未钉住。用法：/stay [小时]（默认 2）。')
          }
          break
        }
        const hours = Number(arg)
        if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
          await this.reply(chat, '小时数无效（1~72）。用法：/stay [小时]。')
          break
        }
        binding.stayUntil = Date.now() + hours * 3600 * 1000
        this.persistBindings()
        await this.reply(chat, `已钉住【${this.projectLabel(binding.projectId)}】上下文 ${hours} 小时（期间自动路由静默，M2 生效）。`)
        break
      }
      case '/history':
        await this.sendHistory(chat, arg)
        break
      case '/models':
        await this.showModelsMenu(chat)
        break
      case '/model':
        await this.handleModelCommand(chat, arg)
        break
      default:
        // 命令表已过滤，理论上到不了这里；兜底提示
        await this.reply(chat, `未知命令「${trimmed}」。可用命令：/help /projects /project /sessions /home /new /stay /history /models /model /stop /status`)
    }
  }

  /** /models：按 provider 分组列模型，当前生效模型打 ★，编号菜单（model-choice）。 */
  async showModelsMenu(chat) {
    const models = await this.listAllModels()
    if (models === null) {
      await this.reply(chat, '当前 DSH 版本不支持模型查询。')
      return
    }
    if (models.length === 0) {
      await this.reply(chat, '未找到可用模型（provider 无凭据或未配置）。')
      return
    }
    const current = this.modelSelectionFor(chat)
    const lines = []
    let lastProvider = null
    models.forEach((m, i) => {
      if (m.provider !== lastProvider) {
        lines.push(`〔${m.provider}〕`)
        lastProvider = m.provider
      }
      const isCur = current?.provider === m.provider && current?.model === m.model
      lines.push(`${i + 1}. ${m.model}${isCur ? ' ★当前' : ''}`)
    })
    this.setMenu(chat, { kind: 'model-choice', items: models })
    await this.reply(chat, `【可用模型】\n${lines.join('\n')}\n回复数字选择，或用 /model <名称>。`)
  }

  /** /model：无参=查当前；数字=菜单选择；名称=精确 id 或唯一子串匹配。 */
  async handleModelCommand(chat, arg) {
    if (!arg) {
      const current = this.modelSelectionFor(chat)
      await this.reply(chat, current?.model
        ? `当前模型：${current.model}（provider ${current.provider || '默认'}）\n/models 查看列表切换。`
        : '当前使用 DSH 全局默认模型。\n/models 查看列表切换。')
      return
    }
    const models = await this.listAllModels()
    if (models === null) {
      await this.reply(chat, '当前 DSH 版本不支持模型查询。')
      return
    }
    if (models.length === 0) {
      await this.reply(chat, '未找到可用模型（provider 无凭据或未配置）。')
      return
    }
    // 数字：走当前活跃菜单（若为模型菜单）
    if (/^\d+$/.test(arg)) {
      const menu = this.activeMenu(chat)
      if (menu?.kind !== 'model-choice') {
        await this.reply(chat, '请先 /models 查看列表，再回复编号。')
        return
      }
      const n = Number(arg)
      if (n < 1 || n > menu.items.length) {
        await this.reply(chat, `编号超出范围（1~${menu.items.length}）。`)
        return
      }
      const item = menu.items[n - 1]
      this.menus.delete(chat.key)
      await this.switchModel(chat, item.provider, item.model)
      return
    }
    // 名称：精确 id 优先，否则子串匹配（须唯一）
    const lower = arg.toLowerCase()
    const exact = models.filter((m) => m.model.toLowerCase() === lower)
    const hits = exact.length === 1 ? exact : models.filter((m) => m.model.toLowerCase().includes(lower))
    if (hits.length === 0) {
      await this.reply(chat, `没有匹配「${arg}」的模型，/models 查看列表。`)
      return
    }
    if (hits.length > 1) {
      const sample = hits.slice(0, 8).map((m) => `${m.provider}/${m.model}`).join('\n')
      await this.reply(chat, `「${arg}」匹配到 ${hits.length} 个模型：\n${sample}${hits.length > 8 ? '\n…' : ''}\n请用更完整的名称。`)
      return
    }
    await this.switchModel(chat, hits[0].provider, hits[0].model)
  }

  /** 编号菜单选择（菜单存在且未过期时调用）。 */
  async handleMenuSelection(chat, n) {
    const menu = this.activeMenu(chat)
    if (!menu) {
      await this.reply(chat, '菜单已失效，请重新 /sessions')
      return
    }
    if (!Number.isInteger(n) || n < 1 || n > menu.items.length) {
      await this.reply(chat, `编号超出范围（1~${menu.items.length}）。`)
      return
    }
    if (menu.kind === 'projects') {
      await this.switchProject(chat, menu.items[n - 1].id)
    } else if (menu.kind === 'sessions') {
      const item = menu.items[n - 1]
      await this.switchSession(chat, item.id, item.title)
    } else if (menu.kind === 'route-choice' || menu.kind === 'route-suggest') {
      // 路由菜单（歧义三选一 / 切出建议）：选项目则切，选"留日常/就在这聊"则不动
      const item = menu.items[n - 1]
      if (item.stay) {
        await this.reply(chat, item.label === '留日常' ? '好，留在日常。' : '好，就在当前项目聊。')
      } else {
        await this.switchProject(chat, item.projectId)
      }
    } else if (menu.kind === 'model-choice') {
      // 模型菜单：直接数字回复选择（同 /model <n>）
      const item = menu.items[n - 1]
      await this.switchModel(chat, item.provider, item.model)
    }
    this.menus.delete(chat.key)
  }

  /** /sessions：列当前项目会话（分页 ≤8，关键词过滤；n=下一页）。
   *  响应优化：进入即发微信原生「正在输入…」状态，慢查询期间用户有即时反馈。 */
  async showSessionsMenu(chat, arg = '') {
    if (!chat.isGroup) this.setTyping(chat, true).catch(() => {})
    try {
      await this.showSessionsMenuInner(chat, arg)
    } finally {
      if (!chat.isGroup) this.setTyping(chat, false).catch(() => {})
    }
  }

  async showSessionsMenuInner(chat, arg = '') {
    const binding = this.getBinding(chat)
    const projectPath = binding.projectId === DAILY_PROJECT_ID ? dailyDir(false) : binding.projectId
    const sessions = await this.listProjectSessions(projectPath)
    if (sessions === null) {
      await this.reply(chat, '当前 DSH 版本不支持会话查询。')
      return
    }
    if (sessions.length === 0) {
      await this.reply(chat, `【${this.projectLabel(binding.projectId)}】下暂无会话记录。下一条消息将新建会话。`)
      return
    }
    // 关键词过滤（按标题包含）
    let keyword = ''
    let items = sessions
    const lower = arg.toLowerCase()
    if (arg && arg !== 'n' && !/^\d+$/.test(arg)) {
      keyword = arg
      items = sessions.filter((s) => s.title.toLowerCase().includes(lower))
      if (items.length === 0) {
        await this.reply(chat, `没有标题含「${truncate(arg, 20)}」的会话。试试别的关键词，或不带参数看全部。`)
        return
      }
    }
    // 页码：数字=跳页，n=下一页（基于上次菜单页）
    const totalPages = Math.max(1, Math.ceil(items.length / SESSIONS_PAGE_SIZE))
    let page = 1
    const prev = this.menus.get(chat.key)
    if (/^\d+$/.test(arg)) page = Math.max(1, Math.min(Number(arg), totalPages))
    else if (arg === 'n' && prev?.kind === 'sessions' && !keyword) page = Math.min((prev.page ?? 1) % totalPages + 1, totalPages)
    const slice = items.slice((page - 1) * SESSIONS_PAGE_SIZE, page * SESSIONS_PAGE_SIZE)
    const fmt = (ts) => (ts > 0 ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '—')
    const lines = slice.map((s, i) => {
      const no = (page - 1) * SESSIONS_PAGE_SIZE + i + 1
      const cur = binding.sessionByProject?.[binding.projectId] === s.id ? ' ✓当前' : ''
      return `${no}. 《${s.title}》 ${fmt(s.updatedAt)}${cur}`
    })
    this.setMenu(chat, { kind: 'sessions', items, page, keyword })
    const head = keyword ? `（关键词「${truncate(keyword, 20)}」，${items.length} 条）` : ''
    await this.reply(chat, `【会话·${this.projectLabel(binding.projectId)}】${head} 第 ${page}/${totalPages} 页\n${lines.join('\n')}\n回复数字切换；发 n 看下一页；/sessions <关键词> 搜索。`)
  }

  /** 内存历史为空时（刚启动/刚切换），从 sessionQuery 事件流重建最近 n 轮 user/assistant 对话。
   *  事件形态：user/message → data.content；assistant/message → data.message.content（与 DSH extraction 同源）。
   *  任何失败都返回空数组（调用方给降级提示），绝不向上抛。 */
  async loadPersistedTurns(chat, n) {
    try {
      const query = this.getSessionQuery()
      if (!query || typeof query.listEvents !== 'function') return []
      const binding = this.getBinding(chat)
      const sessionId = binding.sessionByProject?.[binding.projectId]
      if (!sessionId) return []
      const events = await query.listEvents(sessionId)
      if (!Array.isArray(events)) return []
      const turns = []
      for (const record of events) {
        const event = record?.event ?? record
        if (event?.type === 'user/message') {
          const text = contentItemsText(event.data?.content)
          if (text) turns.push({ role: 'user', text })
        } else if (event?.type === 'assistant/message') {
          const text = contentItemsText(event.data?.message?.content)
          if (text) turns.push({ role: 'assistant', text })
        }
      }
      return turns.slice(-n * 2)
    } catch (error) {
      this.log.warn?.(`读取会话事件历史失败（忽略）：${error?.message ?? error}`)
      return []
    }
  }

  /** /history [n]：当前会话最近 n 轮（默认 5），脱敏后分段发送（≤20 段）。 */
  async sendHistory(chat, arg = '') {
    let n = Number(arg)
    if (!arg) n = 5
    if (!Number.isInteger(n) || n < 1 || n > HISTORY_MAX_TURNS) {
      await this.reply(chat, `用法：/history [轮数]（1~${HISTORY_MAX_TURNS}，默认 5；过长自动按 20 段截断）。`)
      return
    }
    const history = chat.history ?? []
    let turns = history.length > 0
      ? history.slice(-n * 2).map((h) => ({ role: h.role, text: h.text }))
      : await this.loadPersistedTurns(chat, n)
    if (turns.length === 0) {
      const where = this.getBinding(chat).projectId === DAILY_PROJECT_ID ? '日常' : '当前项目'
      await this.reply(chat, `暂无对话记录。刚启动时本地缓存的会话历史可能尚未载入：先发一条消息激活会话，或用 /sessions 确认当前指向的会话（当前在【${where}】）。`)
      return
    }
    const body = ['【最近对话】', ...turns.map((h) => `${h.role === 'user' ? '👤' : '🤖'} ${redactText(h.text)}`)].join('\n')
    const maxChars = Math.max(200, Number(this.config.maxReplyChars) || 1500)
    const parts = splitForSend(body, maxChars)
    if (parts.length > HISTORY_MAX_SEGMENTS) {
      // 截断 = 只发前 20 段（每段一条消息），另发一条提示
      for (const part of parts.slice(0, HISTORY_MAX_SEGMENTS)) await this.reply(chat, part)
      await this.reply(chat, `（内容过长，已截断至 ${HISTORY_MAX_SEGMENTS} 段，可用 /history <更小轮数> 缩小范围）`)
      return
    }
    for (const part of parts) await this.reply(chat, part)
  }

  /** 向微信发送回复（自动按配置切段；非流式长回复按 (i/n) 编号）。 */
  async reply(chat, text) {
    const maxChars = Math.max(200, Number(this.config.maxReplyChars) || 1500)
    const parts = splitForSend(String(text), maxChars)
    const numbered = this.config.streaming === false && parts.length > 1
    for (let i = 0; i < parts.length; i++) {
      const part = numbered ? `(${i + 1}/${parts.length}) ${parts[i]}` : parts[i]
      try {
        await this.client.sendText(chat.to, part, chat.contextToken || '')
        this.log.info(`已回传（${chat.isGroup ? `群 ${chat.to}` : `联系人 ${chat.to}`}）：${truncate(part.replace(/\n/g, ' '), 80)}`)
      } catch (error) {
        this.log.error(`发送失败（${chat.isGroup ? `群 ${chat.to}` : `联系人 ${chat.to}`}）：${error?.message ?? error}`)
        return
      }
      if (parts.length > 1) await this.sleep(250)
    }
  }

  /** 切换微信"正在输入…"状态（尽力而为，失败静默；群聊无此能力）。 */
  async setTyping(chat, on) {
    try {
      if (this.config.typing === false || this.override.typing === false) return
      if (chat.isGroup) return
      if (!this.client || this.phase !== 'running') return
      // 缓存 typing ticket；失败时清空以便下次重取
      if (!chat.typingTicket) {
        const resp = await this.client.getTypingTicket(chat.to, chat.contextToken || '')
        chat.typingTicket = resp?.typing_ticket
        if (!chat.typingTicket) return
      }
      await this.client.sendTyping(chat.to, chat.typingTicket, on ? TypingStatus.TYPING : TypingStatus.CANCEL)
    } catch {
      chat.typingTicket = undefined // 票据可能失效，下次重取
    }
  }

  /** 释放某个联系人的会话（/new 或空闲超时）。keepIndex=true 时保留索引（插件卸载用，重启可恢复）。 */
  async teardownChat(chat, options = {}) {
    chat.tornDown = true
    const handle = chat.handle
    chat.agent = null
    chat.handle = null
    chat.sessionId = null
    chat.buffer = ''
    chat.footer = ''
    chat.busy = false
    chat.sanitizer = null
    chat.renderer = null
    // 只删除自己：拆除期间若已有新会话对象顶替，绝不误删
    if (this.chats.get(chat.key) === chat) this.chats.delete(chat.key)
    if (!options.keepIndex && this.chatIndex[chat.key]) {
      // 保留 contextToken（定时任务主动推送需要），仅清除会话 ID（下次消息新建会话）
      const prev = this.chatIndex[chat.key]
      if (prev?.contextToken) {
        this.chatIndex[chat.key] = { contextToken: prev.contextToken, lastActive: Date.now() }
      } else {
        delete this.chatIndex[chat.key]
      }
      saveChatIndex(this.stateDir, this.chatIndex)
    }
    if (handle) {
      try { await handle.dispose() } catch (error) {
        this.log.warn(`会话释放异常：${error?.message ?? error}`)
      }
    }
  }

  /** 全局节拍：消费会话日志 → 流式缓冲 → 定时发送；空闲回收；锁心跳；热加载覆盖配置。 */
  tick() {
    if (this.disposed) return
    const now = Date.now()
    // 长轮询假死看门狗：poll 事件长时间不来说明长轮询可能已静默挂起，
    // 主动 stop 客户端（monitorLoop 会按冷却时间自动重建监听）。
    const watchdogSecs = Number(this.config.pollWatchdogSecs)
    if (this.phase === 'running' && this.client && watchdogSecs > 0 && this.lastPollAt > 0 && now - this.lastPollAt > watchdogSecs * 1000) {
      this.log.warn(`长轮询静默超过 ${watchdogSecs} 秒，判定假死，重启监听。`)
      this.lastPollAt = Date.now() // 防重建期间反复触发
      try { this.client.stop() } catch { /* ignore */ }
    }
    // 单例锁心跳（20 秒一次）
    if (this.lockOwned && now - this.lastLockBeat > 20000) {
      this.lastLockBeat = now
      this.writeLock()
    }
    // override.json 热加载（5 秒一次）
    this.refreshOverride()
    // 定时任务检查（cron）
    this.checkJobs(now)
    // 文件回传扫描（约 2 秒一次）
    if (this.config.outbox !== false && now - this.lastOutboxScan > 2000) {
      this.lastOutboxScan = now
      this.scanOutboxes().catch(() => {})
    }
    for (const chat of [...this.chats.values()]) {
      // 空闲回收（没有 Agent 的残留会话同样回收，避免泄漏）
      const timeoutMs = Number(this.config.idleTimeoutMins) * 60 * 1000
      if (timeoutMs > 0 && now - chat.lastActive > timeoutMs && (!chat.agent || !chat.busy)) {
        this.log.info(`联系人 ${chat.to} 空闲超时，自动结束会话。`)
        this.teardownChat(chat).catch((e) => this.log.warn(`回收异常：${e?.message ?? e}`))
        continue
      }
      if (!chat.agent) continue
      this.drain(chat, now)
    }
  }

  /** 读取会话新增事件，更新缓冲与忙闲状态，按需发送。 */
  drain(chat, now) {
    const session = chat.agent?.session
    if (!session) return
    const events = session.events
    let dirty = false
    let turnEnded = false
    for (let i = chat.lastSeq; i < events.length; i++) {
      const event = events[i]
      if (event.type === 'turn/start') {
        chat.busy = true
        chat.footer = ''
        dirty = true
        // 思考开始：微信端显示"正在输入…"；记录起点用于"正在处理"提示
        chat.turnStartedAt = now
        chat.waitingNoteSent = false
        chat.sawOutput = false
        this.setTyping(chat, true).catch(() => {})
      } else if (event.type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // 消毒：剥离工具调用 XML 与思考块，避免把原始标记发给手机
          chat.sanitizer ??= createStreamSanitizer()
          let clean = chat.sanitizer.feed(chunk.text)
          // sawOutput 记录本轮是否产生过用户可见文字（表格被排版渲染器扣住时
          // 缓冲可能暂时为空，但输出确实在流动，不应触发"正在处理"提示）
          if (clean) chat.sawOutput = true
          // 微信排版：把 Markdown 转成微信可读的纯文本（可选，流式安全）
          if (clean && this.config.wechatMarkdown !== false) {
            chat.renderer ??= createWeChatMarkdownRenderer()
            clean = chat.renderer.feed(clean)
          }
          if (clean) {
            chat.buffer += clean
            dirty = true
          }
        }
      } else if (event.type === 'turn/end') {
        chat.busy = false
        turnEnded = true
        // 思考结束：取消"正在输入…"
        this.setTyping(chat, false).catch(() => {})
        // 结算消毒器残留（若抑制态未闭合，残留会被丢弃），再结算排版渲染器
        // （渲染器可能扣住了表格行/半行，即使 sanitizer 无残留也必须 flush）
        let rest = chat.sanitizer?.flush() ?? ''
        if (this.config.wechatMarkdown !== false && chat.renderer) {
          rest = chat.renderer.feed(rest) + chat.renderer.flush()
        }
        if (rest) chat.buffer += rest
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          chat.footer = `\n⚠️ 出错了：${truncate(reason.error?.message ?? '未知错误', 200)}`
        } else if (reason?.kind === 'aborted') {
          chat.footer = '\n（已停止）'
        } else if (reason?.kind === 'blocked') {
          chat.footer = '\n（任务被暂停，等待人工处理）'
        } else if (this.config.usageFooter !== false) {
          // 正常结束：附加模型与用量统计（严格对齐 GUI 回合尾注格式，会话投影同源数据）
          try {
            const snap = this.ctx.get('sessionProjections')?.snapshot?.(chat.agent.session)
            const usage = snap?.values?.tokenUsage
            const pressure = snap?.values?.contextPressure
            const label = String(this.config.usageFooterPath || '~/.dsh-wechat-plus')
            let footer = ''
            if (usage) {
              const pct = pressure?.contextWindow > 0 && pressure?.projectedTokens > 0
                ? Math.min(100, Math.round((pressure.projectedTokens / pressure.contextWindow) * 100))
                : null
              const parts = []
              parts.push(`out ${fmtTokens(usage.outputTokens)}`)
              parts.push(`in ${fmtTokens(usage.uncachedInputTokens)} cw ${fmtTokens(usage.cacheWriteTokens)} cr ${fmtTokens(usage.cacheReadTokens)}`)
              if (pct !== null) parts.push(`ctx ${pct}%`)
              footer = `${chat.model || 'model'} · ${parts.join(' · ')} ${label}`
            } else {
              // 投影不可用时的降级：tokenMeter.measure 的 provider 用量与表面积
              const meter = this.ctx.get('tokenMeter')
              if (meter?.measure) {
                const m = meter.measure(chat.agent.session)
                const u = m?.baseline?.kind === 'usage' ? m.baseline.usage : null
                const bits = []
                if (u?.completion_tokens != null) bits.push(`out ${fmtTokens(u.completion_tokens)}`)
                if (u?.prompt_tokens != null) bits.push(`in ${fmtTokens(u.prompt_tokens)}`)
                if (m?.surfaceTokens > 0) bits.push(`ctx ${fmtTokens(m.surfaceTokens)}`)
                if (bits.length > 0) footer = `${chat.model || 'model'} · ${bits.join(' · ')} ${label}`
              }
            }
            if (footer && chat.sawOutput) chat.footer = `\n${footer}`
          } catch (error) { this.log.warn(`用量统计失败：${error?.message ?? error}`) }
        }
        dirty = true
      }
      chat.lastSeq = i + 1
    }
    // 双保险反馈：思考超过阈值仍无可见输出时，主动告知"正在处理"（每轮一次）
    const waitSecs = Number(this.config.waitNoteSecs)
    if (!turnEnded && chat.busy && waitSecs > 0 && !chat.waitingNoteSent && !chat.sawOutput && (now - (chat.turnStartedAt ?? now)) > waitSecs * 1000) {
      chat.waitingNoteSent = true
      this.reply(chat, '⏳ 正在处理，请稍候…').catch(() => {})
    }
    if (!dirty) return
    const buffered = chat.buffer.length > 0
    const sizeReached = chat.buffer.length >= FLUSH_SIZE
    const idleReached = now - chat.lastFlush >= FLUSH_IDLE_MS
    const shouldSend = this.config.streaming === false ? turnEnded : (turnEnded || sizeReached || idleReached)
    if (!shouldSend) return
    if (!buffered && !chat.footer) return
    let payload = (chat.buffer + chat.footer).trim()
    if (!payload) return
    let keep = ''
    // 非回合结束的流式发送：按句读/空白/URL 边界切割，避免把词从中间切断
    // （模型流的停顿点常在词中间，直接整段发会产生"抓\n取成功"这类半词碎片）。
    // 词中间的部分留在缓冲里，等后续流补齐或回合结束时一起发。
    if (!turnEnded && this.config.streaming !== false) {
      if (payload.length >= FLUSH_SIZE) {
        const cut = safeSendCut(payload, 160)
        if (cut > 0 && cut < payload.length) {
          keep = payload.slice(cut)
          payload = payload.slice(0, cut)
        } else {
          // 长串没有任何安全断点（罕见）：按上限硬切，避免缓冲无限增长
          keep = payload.slice(FLUSH_SIZE)
          payload = payload.slice(0, FLUSH_SIZE)
        }
      } else {
        const cut = safeSendCut(payload, payload.length)
        if (cut > 0 && cut < payload.length) {
          keep = payload.slice(cut)
          payload = payload.slice(0, cut)
        } else {
          // 尚无安全断点：暂不发送，继续缓冲，防止半词碎片
          chat.lastFlush = now
          return
        }
      }
    }
    // 滚动历史（/history 用）：累计本轮已发送的正文（不含尾注）
    const sentFooter = chat.footer
    chat.buffer = keep.replace(/^\s+/, '')
    chat.footer = ''
    chat.lastFlush = now
    const bodyOnly = sentFooter && payload.endsWith(sentFooter) ? payload.slice(0, -sentFooter.length) : payload
    if (bodyOnly.trim()) chat.turnText = (chat.turnText ?? '') + bodyOnly
    if (turnEnded && chat.turnText && chat.turnText.trim()) {
      this.pushHistory(chat, 'assistant', chat.turnText)
      chat.turnText = ''
    }
    this.reply(chat, payload).catch((e) => this.log.error(`回传异常：${e?.message ?? e}`))
  }

  /** 插件卸载：停止轮询、清定时器、释放全部会话。 */
  async dispose() {
    this.disposed = true
    if (this.ticker) {
      // ctx.setInterval 返回的是 disposer 函数；全局 setInterval 返回 Timeout
      if (typeof this.ticker === 'function') this.ticker()
      else clearInterval(this.ticker)
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)
    try { this.client?.stop() } catch { /* ignore */ }
    this.client = null
    // 卸载时保留会话索引：重启后按联系人恢复上下文
    const pending = [...this.chats.values()].map((chat) => this.teardownChat(chat, { keepIndex: true }))
    await Promise.allSettled(pending)
    this.releaseSingleton()
    this.log.info('wechat-plus 已停止。')
  }
}

/** Cordis 插件入口。 */
export function apply(ctx, config) {
  const log = makeLogger(ctx, join(resolveDshHome(), 'wechat-plus'))
  if (!config.enabled) {
    log.info('插件已加载但未启用（enabled=false），不进行登录与收发。')
    return
  }
  // DSH/Cordis 的生命周期：ctx.effect 的返回值是 fiber 卸载时执行的清理函数。
  // （注意：这个 Cordis 分支没有 'dispose' 事件，必须用 effect 注册清理。）
  ctx.effect(() => {
    const bridge = new WeChatBridge(ctx, config, log)
    // 注册微信桥接专属工具（全局工具注册表，不依赖 Agent 预设；微信侧智能体必然可见）
    bridge.registerTools(ctx)
    void bridge.start()
    return () => {
      for (const dispose of bridge.toolDisposers) {
        try { dispose() } catch { /* ignore */ }
      }
      bridge.toolDisposers = []
      void bridge.dispose()
    }
  }, 'wechat-plus')
}
