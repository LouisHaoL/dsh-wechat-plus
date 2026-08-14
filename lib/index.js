// dsh-wechat-bridge — DSH 微信桥接插件
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

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import qrcode from 'qrcode'
import { WeChatClient, MessageType, MessageItemType, TypingStatus } from 'wechat-ilink-client'

export const name = 'wechat-bridge'
// 本 Cordis 分支对 ctx 属性访问是严格模式：用到的服务必须声明在 inject 里
// （timer 用于 ctx.setInterval 的 fiber 级定时器）
export const inject = ['agents', 'sessions', 'timer']

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
  tts: z.boolean().default(false).description('语音回复：AI 回复同时以语音消息播报（微软 Edge 朗读服务，需联网）。'),
  ttsVoice: z.string().default('zh-CN-YunxiNeural').description('TTS 音色（如 zh-CN-YunxiNeural 男声 / zh-CN-XiaoxiaoNeural 女声）。')
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

/** 运行时覆盖配置：避开 DSH patch 重载缺陷，白名单/管理员可热调整。 */
function loadOverride(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, OVERRIDE_FILENAME), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 无覆盖文件 */ }
  return {}
}

/** 联系人 → 会话 ID 的持久索引（重启后恢复上下文）。 */
function loadChatIndex(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, CHAT_INDEX_FILENAME), 'utf8'))
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
    try { ctx.logger?.[method]?.(`[wechat-bridge] ${text}`) } catch { /* ignore */ }
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
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
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
    console.error(`[wechat-bridge] 状态写入失败: ${error?.message ?? error}`)
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

/** 按文件头魔数推断图片扩展名。 */
function guessImageExtension(data) {
  if (!data || data.length < 4) return '.jpg'
  if (data[0] === 0xff && data[1] === 0xd8) return '.jpg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return '.webp'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif'
  return '.jpg'
}

// ---- 极简 cron 解析器（5 段：分 时 日 月 星期，星期 0=周日）----

function parseCronField(spec, min, max) {
  const set = new Set()
  for (const seg of String(spec).split(',')) {
    if (seg === '*') {
      for (let i = min; i <= max; i++) set.add(i)
    } else if (seg.startsWith('*/')) {
      const step = Number(seg.slice(2))
      if (!Number.isInteger(step) || step <= 0) return null
      for (let i = min; i <= max; i += step) set.add(i)
    } else if (seg.includes('-')) {
      const [a, b] = seg.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return null
      for (let i = a; i <= b; i++) set.add(i)
    } else {
      const n = Number(seg)
      if (!Number.isInteger(n) || n < min || n > max) return null
      set.add(n)
    }
  }
  return set
}

/** 解析 5 段 cron 表达式；无效返回 null。 */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseCronField(parts[0], 0, 59)
  const hour = parseCronField(parts[1], 0, 23)
  const day = parseCronField(parts[2], 1, 31)
  const month = parseCronField(parts[3], 1, 12)
  const dow = parseCronField(parts[4], 0, 6)
  if (!minute || !hour || !day || !month || !dow) return null
  return { minute, hour, day, month, dow }
}

function cronMatches(cron, date) {
  return cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.day.has(date.getDate()) &&
    cron.month.has(date.getMonth() + 1) &&
    cron.dow.has(date.getDay())
}

/** fromTs 之后的下一个触发时刻（步进 1 分钟，最多扫 400 天；无匹配返回 null）。 */
export function nextCronAfter(cron, fromTs) {
  const d = new Date(fromTs + 60000)
  d.setSeconds(0, 0)
  for (let i = 0; i < 400 * 24 * 60; i++) {
    if (cronMatches(cron, d)) return d.getTime()
    d.setTime(d.getTime() + 60000)
  }
  return null
}

/** 定时任务最近触发时间（重启后不重复触发同一分钟）。 */
function loadJobState(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'jobs-state.json'), 'utf8'))
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

// ---- TTS：子进程隔离 ----
// msedge-tts 内部存在无 catch 的游离 Promise，在主进程内运行可能触发
// DSH 的 fail-loud 退出（未处理拒绝 → 整个应用退出）。因此 TTS 一律在
// 子进程执行（scripts/tts-worker.mjs），第三方库任何异常都不会波及 DSH。

let ttsWorkerFactory = null

/** 测试专用：注入 TTS 合成函数替身（避免测试访问真实 TTS 服务）。 */
export function setTtsWorkerFactoryForTests(fn) {
  ttsWorkerFactory = fn
}

/** 在子进程中合成语音，返回 mp3 文件路径；任何失败抛出（由调用方静默）。 */
async function synthesizeTts(text, outDir, voice) {
  if (ttsWorkerFactory) return ttsWorkerFactory(text, outDir, voice)
  const { spawn } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const worker = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tts-worker.mjs')
  const textFile = join(outDir, `input-${Date.now()}.txt`)
  writeFileSync(textFile, text, 'utf8')
  return await new Promise((resolve, reject) => {
    // 在 Electron 应用里 process.execPath 是应用 exe；ELECTRON_RUN_AS_NODE=1 让其以纯 Node 模式运行
    const env = { ...process.env }
    if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [worker, textFile, outDir, voice], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 忽略 */ }
      reject(new Error('TTS 子进程超时（30 秒）'))
    }, 30000)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        const file = stdout.trim().split(/\r?\n/).pop()
        if (file) resolve(file)
        else reject(new Error('TTS 子进程未输出文件路径'))
      } else {
        reject(new Error(`TTS 子进程退出码 ${code}：${stderr.trim().slice(0, 200)}`))
      }
    })
  })
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

const HELP_TEXT = `【DSH 微信助手】使用说明：
• 直接发消息，AI 会处理并流式回复
• /new    开始新会话（清空上下文）
• /stop   停止当前任务
• /status 查看当前状态
• /help   显示本说明
安全提示：纯链接消息默认不处理；机器人只做消息中转。
控制命令（/new /stop /status）仅管理员可用。`

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

// ---- 流式文本消毒器 ----
// 模型原始流里会混入工具调用 XML（<tool_calls>/<invoke>…）与思考块
// （<zhimayc-think>/<think>…），这些不该发给手机。文本按 token 分片到达，
// 标签可能被切在两片之间，所以用有状态扫描 + 尾部保留处理跨片标签。

const SANITIZE_OPEN_TAGS = ['<tool_calls>', '<invoke', '<zhimayc-think>', '<think>', '<thinking>', '<reasoning>', '<bash', '<tool_call', '<function_call', '<function-call']
const SANITIZE_CLOSE_TAGS = ['</invoke>', '</tool_calls>', '</zhimayc-think>', '</think>', '</thinking>', '</reasoning>', '</bash>', '</tool_call>', '</function_call>', '</function-call>']
const ALL_SANITIZE_TAGS = [...SANITIZE_OPEN_TAGS, ...SANITIZE_CLOSE_TAGS]

/** pending 尾部若是某个标签的前缀，返回应保留的字符数（等待后续分片补齐）。 */
function tagHoldLength(text) {
  const idx = text.lastIndexOf('<')
  if (idx < 0) return 0
  const tail = text.slice(idx)
  for (const tag of ALL_SANITIZE_TAGS) {
    if (tag.startsWith(tail) && tail.length < tag.length) return tail.length
  }
  return 0
}

/** 创建消毒器：feed() 逐片喂入并返回干净文本；flush() 结算残留。 */
export function createStreamSanitizer() {
  let pending = ''
  let suppress = 0
  return {
    feed(text) {
      pending += text
      const hold = tagHoldLength(pending)
      const limit = pending.length - hold
      let out = ''
      for (let i = 0; i < limit; i++) {
        const rest = pending.slice(i)
        let tag = null
        for (const t of SANITIZE_OPEN_TAGS) {
          if (rest.startsWith(t)) { tag = t; break }
        }
        if (tag) {
          suppress++
          i += tag.length - 1
          continue
        }
        tag = null
        for (const t of SANITIZE_CLOSE_TAGS) {
          if (rest.startsWith(t)) { tag = t; break }
        }
        if (tag) {
          if (suppress > 0) suppress--
          i += tag.length - 1
          continue
        }
        if (suppress === 0) out += pending[i]
      }
      pending = pending.slice(limit)
      return out
    },
    flush() {
      const out = suppress === 0 ? pending : ''
      pending = ''
      suppress = 0
      return out
    }
  }
}

/**
 * 桥接主类：管理凭证、长轮询、每个联系人的 Agent 会话与流式回传。
 * clientFactory 供测试注入模拟微信客户端（默认使用真实 wechat-ilink-client）。
 */
export class WeChatBridge {
  constructor(ctx, config, log, clientFactory = defaultClientFactory) {
    this.ctx = ctx
    this.config = config
    this.log = log ?? makeLogger(ctx, join(resolveDshHome(), 'wechat-bridge'))
    this.clientFactory = clientFactory
    this.stateDir = join(resolveDshHome(), 'wechat-bridge')
    this.state = loadState(this.stateDir)
    this.chats = new Map()       // key -> chat 记录
    this.seen = new Set()        // 已处理消息 id
    this.client = null
    this.phase = 'idle'          // idle | login | running
    this.disposed = false
    this.ticker = null
    this.monitorTask = null
    this.retryTimer = null
    this.attachedClients = new WeakSet()
    this.lockPath = join(this.stateDir, 'bridge.lock')
    this.lockOwned = false
    this.lastLockBeat = 0
    // v3：运行时覆盖配置 + 会话索引（重启恢复）
    this.override = loadOverride(this.stateDir)
    this.overrideMtime = 0
    this.lastOverrideCheck = 0
    this.chatIndex = loadChatIndex(this.stateDir)
    // v4：定时任务
    this.jobState = loadJobState(this.stateDir)
    this.jobRuntime = new Map()
    this.jobsBoundTo = null
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
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'))
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
    if (msg.group_id) {
      // v1 仅支持私聊；群消息只记日志，避免在群里刷屏
      this.log.info(`收到群消息（v1 暂不支持群聊，已忽略）：group=${msg.group_id}`)
      return
    }
    const userId = msg.from_user_id
    if (!userId) return

    // 白名单（override.json 热调整优先）
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

    const key = `u:${userId}`
    const chat = this.ensureChat(key, userId)
    chat.contextToken = msg.context_token ?? chat.contextToken
    chat.lastActive = Date.now()
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
      chat.contextToken = msg.context_token ?? chat.contextToken
      chat.lastActive = Date.now()
    }
    const text = extractUsableText(msg)

    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      await this.handleCommand(chat, trimmed)
      return
    }

    if (!text) {
      if (hasMediaItem(msg)) {
        const hasUnsupported = (msg.item_list ?? []).some((item) => item.type === MessageItemType.FILE || item.type === MessageItemType.VIDEO)
        if (hasUnsupported) {
          await this.reply(chat, '文件、视频暂未开放；图片可以直接发。')
        }
        // 纯图片消息：走下方图片处理（text 为空时仍转发图片路径）
      }
      if (!imageItems(msg).length) return
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

    // 确保有 Agent（优先恢复持久化会话；/new 后或首次消息时新建）
    if (!chat.agent) {
      try {
        await this.ensureAgentFor(chat)
      } catch (error) {
        this.log.error(`创建/恢复 Agent 失败：${error?.stack ?? error?.message ?? error}`)
        await this.reply(chat, `⚠️ AI 启动失败：${truncate(error?.message ?? String(error), 120)}`)
        return
      }
    }

    try {
      const content = [{ type: 'text', text: text || `用户发来图片（无文字）${imageNote ? '' : '，但下载失败'}` }]
      if (imageNote) content[0].text += imageNote
      chat.agent.followup(createUserMessage({
        content,
        source: { kind: 'user' }
      }))
      this.log.info(`已转发消息给 AI（联系人 ${chat.to}，${(text || '').length} 字${images.length ? `，${images.length} 图` : ''}）。`)
    } catch (error) {
      this.log.error(`消息入队失败：${error?.message ?? error}`)
      await this.reply(chat, `⚠️ 消息处理失败：${truncate(error?.message ?? String(error), 120)}`)
    }
  }

  /** 确保联系人有可用 Agent：优先恢复持久化会话，否则新建。 */
  async ensureAgentFor(chat) {
    const indexEntry = this.chatIndex[chat.key]
    let resumed = false
    if (indexEntry?.sessionId) {
      resumed = await this.tryResumeAgentFor(chat, indexEntry.sessionId)
    }
    if (!resumed) await this.createAgentFor(chat)
  }

  /** 为某个联系人创建独立的 DSH Agent 会话。 */
  async createAgentFor(chat) {
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
    const sessionId = SessionId(`wechat-${randomUUID()}`)
    const options = {
      sessionId,
      meta: { cwd: this.resolveWorkDir() }
    }
    if (selection?.provider && selection?.model) {
      options.agentOptions = { provider: selection.provider, model: selection.model }
      // 注意：agent-loop 会对 setup 的返回值调用 ?.commit()（事务提交语义），
      // 因此这里必须用块体写法返回 undefined（与 dsh-headless 的用法一致），
      // 不能把 installModelSelection 的 disposer 作为返回值传出去。
      options.setup = (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      }
    }
    const { agent, dispose } = await agents.create(options)
    chat.agent = agent
    chat.handle = { dispose }
    chat.sessionId = sessionId
    chat.lastSeq = agent.session.seq
    chat.buffer = ''
    chat.footer = ''
    chat.busy = false
    chat.sanitizer = createStreamSanitizer()
    // 持久化联系人 → 会话索引（重启后恢复上下文）；合并式保存，保留已有的 contextToken
    this.chatIndex[chat.key] = { ...(this.chatIndex[chat.key] ?? {}), sessionId: String(sessionId), lastActive: Date.now() }
    saveChatIndex(this.stateDir, this.chatIndex)
    this.log.info(`已为联系人 ${chat.to} 创建会话 ${String(sessionId)}。`)
  }

  /** 恢复联系人上一次的持久化会话；失败（无持久化/损坏/冲突）返回 false。 */
  async tryResumeAgentFor(chat, sessionId) {
    try {
      const agents = this.ctx.get('agents')
      const defaultModel = this.ctx.get('agentDefaultModel')
      const selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
      const options = { resumeSessionId: SessionId(sessionId) }
      if (selection?.provider && selection?.model) {
        options.agentOptions = { provider: selection.provider, model: selection.model }
        // 与 create 一致：块体写法返回 undefined（agent-loop 对返回值调用 ?.commit()）
        options.setup = (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        }
      }
      const { agent, dispose } = await agents.resume(options)
      chat.agent = agent
      chat.handle = { dispose }
      chat.sessionId = sessionId
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

  /** 斜杠命令。控制命令（/new /stop /status）按管理员列表鉴权。 */
  async handleCommand(chat, trimmed) {
    const cmd = trimmed.toLowerCase().split(/\s+/)[0]
    const CONTROL_COMMANDS = ['/new', '/stop', '/status']
    if (CONTROL_COMMANDS.includes(cmd)) {
      const admins = this.effectiveAdmins()
      const isAdmin = admins.length === 0 || admins.includes(chat.to)
      if (!isAdmin) {
        this.log.warn(`非管理员 ${chat.to} 尝试执行控制命令：${cmd}，已拒绝。`)
        await this.reply(chat, '该命令仅管理员可用。')
        return
      }
    }
    switch (cmd) {
      case '/help':
        await this.reply(chat, HELP_TEXT)
        break
      case '/new': {
        this.log.info(`联系人 ${chat.to} 请求新会话。`)
        await this.reply(chat, '已开始新会话，之前的上下文已清空。')
        await this.teardownChat(chat)
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
        const agentState = chat.agent ? String(chat.agent.status ?? 'unknown') : '无会话'
        const busyText = chat.busy ? '（忙）' : ''
        const sessionInfo = chat.sessionId ? `会话：${String(chat.sessionId).slice(0, 12)}…` : '会话：无'
        await this.reply(chat, `【状态】\nAgent：${agentState}${busyText}\n${sessionInfo}\n发送 /new 可开始新会话。`)
        break
      }
      default:
        await this.reply(chat, `未知命令「${trimmed}」。可用命令：/help /new /stop /status`)
    }
  }

  /** 向微信发送回复（自动按配置切段）。 */
  async reply(chat, text) {
    const maxChars = Math.max(200, Number(this.config.maxReplyChars) || 1500)
    const parts = splitForSend(String(text), maxChars)
    for (const part of parts) {
      try {
        await this.client.sendText(chat.to, part, chat.contextToken || '')
        this.log.info(`已回传（联系人 ${chat.to}）：${truncate(part.replace(/\n/g, ' '), 80)}`)
      } catch (error) {
        this.log.error(`发送失败（联系人 ${chat.to}）：${error?.message ?? error}`)
        return
      }
      if (parts.length > 1) await this.sleep(250)
    }
  }

  /** 切换微信"正在输入…"状态（尽力而为，失败静默）。 */
  async setTyping(chat, on) {
    try {
      if (this.config.typing === false || this.override.typing === false) return
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

  /** 语音播报回复（子进程 TTS 生成 mp3 → 语音消息发送；失败静默降级，绝不波及主进程）。 */
  async sendTts(chat, text) {
    try {
      if (this.config.tts !== true && this.override.tts !== true) return
      if (!this.client || this.phase !== 'running') return
      // 去掉标记/页脚，截断到 800 字，避免超长
      const clean = String(text).replace(/<[^>]+>/g, '').replace(/⚠️[^\n]*/g, '').trim().slice(0, 800)
      if (!clean) return
      const dir = join(this.stateDir, 'tts')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const file = await synthesizeTts(clean, dir, this.config.ttsVoice || 'zh-CN-YunxiNeural')
      await this.client.sendMedia(chat.to, file, undefined, chat.contextToken || '')
      this.log.info(`已发送语音回复（联系人 ${chat.to}，${clean.length} 字）。`)
    } catch (error) {
      this.log.warn(`语音回复失败（忽略）：${error?.message ?? error}`)
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
    // 单例锁心跳（20 秒一次）
    if (this.lockOwned && now - this.lastLockBeat > 20000) {
      this.lastLockBeat = now
      this.writeLock()
    }
    // override.json 热加载（5 秒一次）
    this.refreshOverride()
    // 定时任务检查（cron）
    this.checkJobs(now)
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
        // 思考开始：微信端显示"正在输入…"
        this.setTyping(chat, true).catch(() => {})
      } else if (event.type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // 消毒：剥离工具调用 XML 与思考块，避免把原始标记发给手机
          chat.sanitizer ??= createStreamSanitizer()
          const clean = chat.sanitizer.feed(chunk.text)
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
        // 结算消毒器残留（若抑制态未闭合，残留会被丢弃）
        const rest = chat.sanitizer?.flush() ?? ''
        if (rest) chat.buffer += rest
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          chat.footer = `\n⚠️ 出错了：${truncate(reason.error?.message ?? '未知错误', 200)}`
        } else if (reason?.kind === 'aborted') {
          chat.footer = '\n（已停止）'
        } else if (reason?.kind === 'blocked') {
          chat.footer = '\n（任务被暂停，等待人工处理）'
        }
        dirty = true
      }
      chat.lastSeq = i + 1
    }
    if (!dirty) return
    const buffered = chat.buffer.length > 0
    const sizeReached = chat.buffer.length >= FLUSH_SIZE
    const idleReached = now - chat.lastFlush >= FLUSH_IDLE_MS
    const shouldSend = this.config.streaming === false ? turnEnded : (turnEnded || sizeReached || idleReached)
    if (!shouldSend) return
    if (!buffered && !chat.footer) return
    const payload = (chat.buffer + chat.footer).trim()
    if (!payload) return
    chat.buffer = ''
    chat.footer = ''
    chat.lastFlush = now
    this.reply(chat, payload).catch((e) => this.log.error(`回传异常：${e?.message ?? e}`))
    // 轮次结束的整段回复：同步生成语音播报（可配置关闭）
    if (turnEnded) {
      this.sendTts(chat, payload).catch(() => {})
    }
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
    this.log.info('wechat-bridge 已停止。')
  }
}

/** Cordis 插件入口。 */
export function apply(ctx, config) {
  const log = makeLogger(ctx, join(resolveDshHome(), 'wechat-bridge'))
  if (!config.enabled) {
    log.info('插件已加载但未启用（enabled=false），不进行登录与收发。')
    return
  }
  // DSH/Cordis 的生命周期：ctx.effect 的返回值是 fiber 卸载时执行的清理函数。
  // （注意：这个 Cordis 分支没有 'dispose' 事件，必须用 effect 注册清理。）
  ctx.effect(() => {
    const bridge = new WeChatBridge(ctx, config, log)
    void bridge.start()
    return () => {
      void bridge.dispose()
    }
  }, 'wechat-bridge')
}
