// dsh-wechat-bridge 集成测试
//
// 用真实 DSH 服务树（dsh-base bundle + 真实 DeepSeek 模型）驱动 WeChatBridge，
// 以模拟微信客户端（FakeClient）代替真实 iLink 传输层，覆盖：
//   1. 基础问答（文字入站 → Agent 创建 → 回复回传）
//   2. /status、/new、/help 命令
//   3. 纯链接拦截
//   4. 白名单过滤
//   5. /new 后新会话（sessionId 变化）
//   6. 空闲回收
//
// 运行：node test/integration.mjs   （DSH_HOME 自动隔离到 test/.home）

import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { EventEmitter } from 'node:events'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_HOME = join(HERE, '.home')
const PROFILE_DIR = join(TEST_HOME, 'profiles', 'bridge-test')
const WORK_DIR = join(HERE, '.work')
// DSH 安装路径与真实 DSH_HOME：可用环境变量覆盖（开源可移植）
const HOST = process.env.DSH_TEST_HOST ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host'
const REAL_HOME = process.env.DSH_TEST_REAL_HOME ?? 'C:/Users/Administrator/.dsh'

// ---- 准备隔离的 DSH 测试环境 ----
process.env.DSH_HOME = TEST_HOME
mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(WORK_DIR, { recursive: true })
// 每次运行从干净状态开始（清除上次运行的插件侧状态：会话索引/任务状态/覆盖配置/锁/日志）
{
  const stateDir = join(TEST_HOME, 'wechat-bridge')
  for (const f of ['chats.json', 'jobs-state.json', 'override.json', 'bridge.lock', 'state.json', 'bridge.log']) {
    const p = join(stateDir, f)
    if (existsSync(p)) unlinkSync(p)
  }
}
writeFileSync(join(PROFILE_DIR, 'cordis.yml'), '[]\n')
copyFileSync(join(REAL_HOME, '.credentials.yaml'), join(TEST_HOME, '.credentials.yaml'))
copyFileSync(join(REAL_HOME, 'settings.yaml'), join(TEST_HOME, 'settings.yaml'))

const { boot, loadOverlayPatches, healProfilesModuleFallback } = await import(pathToFileURL(HOST + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'))
const { WeChatBridge, apply, setClientFactoryForTests, createStreamSanitizer } = await import(new URL('../lib/index.js', import.meta.url))

// 从真实安装构造模块解析回退（profiles/node_modules 符号链接农场）
healProfilesModuleFallback(HOST + '/package.json', TEST_HOME)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0
const failures = []

async function check(desc, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${desc}`)
  } catch (error) {
    failed++
    failures.push({ desc, error })
    console.log(`  ❌ ${desc}\n     ${error?.message ?? error}`)
  }
}

async function waitFor(desc, cond, timeoutMs, interval = 250) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return
    await sleep(interval)
  }
  throw new Error(`等待超时：${desc}`)
}

/** 不抛异常的探测版 waitFor：用于需要按结果重试的场景。 */
async function probe(desc, cond, timeoutMs, interval = 250) {
  try {
    await waitFor(desc, cond, timeoutMs, interval)
    return true
  } catch {
    return false
  }
}

// ---- 模拟微信客户端 ----
class FakeClient extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.sent = []
    this.started = false
    this.stopped = false
    this.loginCalls = 0
    this._resolveStop = null
    FakeClient.instances = FakeClient.instances ?? new Set()
    FakeClient.instances.add(this)
  }
  async start(opts = {}) {
    this.started = true
    this.startOpts = opts
    return new Promise((resolve) => { this._resolveStop = resolve })
  }
  stop() {
    this.stopped = true
    if (this._resolveStop) {
      const r = this._resolveStop
      this._resolveStop = null
      r()
    }
  }
  async sendText(to, text, contextToken) {
    this.sent.push({ to, text, contextToken })
    return 'ok'
  }
  async getTypingTicket(userId) {
    return { typing_ticket: 'fake-ticket' }
  }
  async sendTyping(userId, ticket, status) {
    this.typingEvents = this.typingEvents ?? []
    this.typingEvents.push({ userId, status, at: Date.now() })
    return 'ok'
  }
  async sendMedia(to, filePath, caption, contextToken) {
    this.mediaSent = this.mediaSent ?? []
    this.mediaSent.push({ to, filePath, contextToken })
    return 'ok'
  }
  async sendUploadedFile(to, fileName, uploaded, caption, contextToken) {
    this.mediaSent = this.mediaSent ?? []
    this.mediaSent.push({ to, filePath: fileName, contextToken })
    return 'ok'
  }
  async sendUploadedImage(to, uploaded, caption, contextToken) {
    this.mediaSent = this.mediaSent ?? []
    this.mediaSent.push({ to, filePath: '(image)', contextToken })
    return 'ok'
  }
  async uploadCdn(cdnUrl, ciphertext) {
    // 测试注入口：模拟 CDN 上传成功，返回下载参数
    return { downloadParam: 'fake-encrypted-param' }
  }
  api = {
    cdnBaseUrl: 'https://example.invalid',
    async getUploadUrl() {
      return { upload_param: 'fake-upload-param' }
    }
  }
  async downloadMedia(item) {
    if (item?.type === 4) {
      // FILE：返回测试文件内容（入站文件接收链路用）
      return { data: Buffer.from('hello file content'), kind: 'file', fileName: item.file_item?.file_name ?? 'test.txt' }
    }
    // 1x1 PNG（最小合法图片，供测试）
    return { data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), kind: 'image' }
  }
  async login(opts = {}) {
    this.loginCalls++
    FakeClient.totalLogins = (FakeClient.totalLogins ?? 0) + 1
    opts.onQRCode?.('https://example.invalid/qr-test')
    opts.onStatus?.('confirmed')
    return { connected: true, botToken: 'fake-token', accountId: 'fake@im.bot', baseUrl: 'https://example.invalid', userId: 'u-fake', message: 'ok' }
  }
}

let mid = 0
function makeMsg(text, overrides = {}) {
  return {
    message_type: 1,
    message_id: ++mid,
    from_user_id: 'u-fake',
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }],
    context_token: 'ctx-1',
    ...overrides
  }
}

/** 指定联系人发一条消息。 */
function makeMsgFrom(userId, text) {
  return makeMsg(text, { from_user_id: userId })
}

function sentText(bridge, from = 0) {
  return bridge.client.sent.slice(from).map((s) => s.text).join('\n')
}

/** 去掉空白后的文本：流式发送可能把标记拆成多条，匹配时忽略换行/空格。 */
function tight(text) {
  return text.replace(/\s+/g, '')
}

// 支持 --rounds N 多轮重复（稳定性验证），默认 2 轮
const roundsArg = process.argv.find((a) => a.startsWith('--rounds='))
const ROUNDS = Math.max(1, Number(roundsArg?.split('=')[1]) || 2)

// ---- 启动真实 DSH 树 ----
console.log('== 阶段 1：启动 DSH 服务树（dsh-base + 真实模型配置）==')
const dshBasePatch = HOST + '/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'
const patches = loadOverlayPatches('dsh', dshBasePatch)
let ctx
try {
  ctx = await boot('dsh', join(PROFILE_DIR, 'cordis.yml'), patches)
  console.log('  树已启动。')
} catch (error) {
  console.error('  启动失败：', error?.message ?? error)
  if (error?.cause) console.error('  原因：', error.cause?.message ?? error.cause)
  process.exit(1)
}

await check('核心服务存在（agents/sessions/agentDefaultModel）', async () => {
  if (!ctx.get('agents')) throw new Error('agents 服务缺失')
  if (!ctx.get('sessions')) throw new Error('sessions 服务缺失')
  if (!ctx.get('agentDefaultModel')) throw new Error('agentDefaultModel 服务缺失')
})

// ---- 构建桥接（注入模拟客户端）----
const bridge = new WeChatBridge(ctx, {
  enabled: true,
  token: '',
  accountId: '',
  baseUrl: 'https://example.invalid',
  allowFrom: ['*'],
  workDir: WORK_DIR,
  blockLinks: true,
  streaming: true,
  idleTimeoutMins: 0,
  maxReplyChars: 1500,
  loginCooldownSecs: 1,
  singleton: false,
  groups: true,
  groupRequireMention: true,
  wechatMarkdown: true,
  pollWatchdogSecs: 0
}, {
  info: (...p) => console.log('   [bridge]', ...p),
  warn: (...p) => console.log('   [bridge]', ...p),
  error: (...p) => console.log('   [bridge]', ...p)
}, FakeClient)

// 预置凭证，跳过扫码
bridge.state.credentials = { token: 'fake-token', accountId: 'fake@im.bot', baseUrl: 'https://example.invalid', userId: 'u-fake' }

console.log('== 阶段 2：桥接启动 ==')
await bridge.start()
await waitFor('桥接进入运行态并建立客户端', () => bridge.phase === 'running' && bridge.client instanceof FakeClient, 15000)

await check('桥接进入 running 状态', async () => {
  if (bridge.phase !== 'running') throw new Error(`phase=${bridge.phase}`)
  if (!(bridge.client instanceof FakeClient)) throw new Error('client 不是模拟客户端')
})

for (let round = 1; round <= ROUNDS; round++) {
  const roundBase = bridge.client.sent.length
  const marker = `桥测-OK-R${round}`
  const marker2 = `轮二-OK-R${round}`
  console.log(`\n========== 第 ${round}/${ROUNDS} 轮 ==========`)

  console.log('== 阶段 3：基础问答（真实模型）==')
  bridge.client.emit('message', makeMsg(`请只回复下面这行文字，不要添加任何其他内容：${marker}`))
  await check('文字消息 → AI 回复回传微信', async () => {
    await waitFor('收到含标记的回复', () => tight(sentText(bridge, roundBase)).includes(marker), 180000)
    const chat = bridge.chats.get('u:u-fake')
    if (!chat?.agent) throw new Error('Agent 未创建')
  })
  await check('回复末尾附带用量统计（⚙ 模型 · out · in · cw · cr · ctx%）', async () => {
    await waitFor('收到用量尾注', () => /⚙ [\w.-]+ · out [\d.k]+ in [\d.k]+ cw \d+(\.\d+k)? cr [\d.k]+ ctx \d+%/.test(sentText(bridge, roundBase)), 30000)
  })

  console.log('== 阶段 4：命令 ==')
  bridge.client.emit('message', makeMsg('/status'))
  await check('/status 返回状态', async () => {
    await waitFor('收到状态回复', () => sentText(bridge, roundBase).includes('【状态】'), 30000)
  })

  bridge.client.emit('message', makeMsg('/help'))
  await check('/help 返回帮助', async () => {
    await waitFor('收到帮助回复', () => sentText(bridge, roundBase).includes('/new'), 30000)
  })

  console.log('== 阶段 5：链接拦截 ==')
  bridge.client.emit('message', makeMsg('https://evil.example.com/phish'))
  await check('纯链接消息被拦截', async () => {
    await waitFor('收到拦截提示', () => sentText(bridge, roundBase).includes('已拦截'), 30000)
  })

  console.log('== 阶段 6：白名单 ==')
  {
    const before = bridge.client.sent.length
    bridge.config.allowFrom = ['u-other']
    bridge.client.emit('message', makeMsg('白名单外的人发消息'))
    await check('非白名单消息被静默忽略', async () => {
      await sleep(3000)
      if (bridge.client.sent.length !== before) throw new Error(`白名单未生效，新增 ${bridge.client.sent.length - before} 条发送`)
    })
    bridge.config.allowFrom = ['*']
  }

  console.log('== 阶段 7：/new 新会话（含紧跟消息竞态）==')
  {
    const firstChat = bridge.chats.get('u:u-fake')
    const firstSessionId = firstChat?.sessionId
    bridge.client.emit('message', makeMsg('/new'))
    await waitFor('收到新会话回复', () => sentText(bridge, roundBase).includes('已开始新会话'), 30000)
    await check('/new 后新消息进入全新会话', async () => {
      // 模型偶发瞬时错误/长延迟：最多尝试 3 次（错误页脚或无输出都算一次未命中）
      let got = false
      let errorFooter = ''
      for (let attempt = 1; attempt <= 3 && !got; attempt++) {
        bridge.client.emit('message', makeMsg(`请只回复下面这行文字：${marker2}`))
        const ok = await probe(`第 ${attempt} 次收到第二轮回复`, () => {
          const text = tight(sentText(bridge, roundBase))
          if (text.includes(marker2)) { got = true; return true }
          if (text.includes('⚠️ 出错了')) { errorFooter = text; return true }
          return false
        }, 300000)
        if (!ok) errorFooter = ''
      }
      if (!got) throw new Error(`第二轮回复失败（三次尝试）${errorFooter ? `\n错误页脚：${errorFooter.split('\n').slice(-3).join('\n')}` : ''}`)
      const chat = bridge.chats.get('u:u-fake')
      if (!chat?.sessionId) throw new Error('第二轮后无会话')
      if (firstSessionId && chat.sessionId === firstSessionId) throw new Error('sessionId 未变化')
    })
  }

  console.log('== 阶段 8：空闲回收 ==')
  {
    bridge.config.idleTimeoutMins = 0.02 // 1.2 秒
    // 给排队中的补发轮次留出完成时间（最长 3 分钟），避免误判回收失败
    await waitFor('空闲超时后会话被回收', () => bridge.chats.size === 0, 180000)
    await check('空闲会话被自动回收', async () => {
      if (bridge.chats.size !== 0) throw new Error(`仍有 ${bridge.chats.size} 个会话`)
    })
    await check('空闲回收后索引保留 contextToken（定时推送需要）', async () => {
      const indexFile = join(TEST_HOME, 'wechat-bridge', 'chats.json')
      if (!existsSync(indexFile)) throw new Error('chats.json 不存在')
      const idx = JSON.parse(readFileSync(indexFile, 'utf8'))
      const entry = idx['u:u-fake']
      if (!entry?.contextToken) throw new Error(`空闲回收丢失了 contextToken：${JSON.stringify(idx)}`)
      if (entry.sessionId) throw new Error('空闲回收后不应保留 sessionId')
    })
    bridge.config.idleTimeoutMins = 0
  }
}

console.log('== 阶段 10：多联系人会话隔离 ==')
{
  const base = bridge.client.sent.length
  const mA = '多联-A-OK'
  const mB = '多联-B-OK'
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${mA}`))
  bridge.client.emit('message', makeMsgFrom('u-b', `请只回复下面这行文字：${mB}`))
  await check('两个联系人各自得到回复', async () => {
    await waitFor('A 收到回复', () => tight(sentText(bridge, base)).includes(mA), 180000)
    await waitFor('B 收到回复', () => tight(sentText(bridge, base)).includes(mB), 180000)
    const chatA = bridge.chats.get('u:u-a')
    const chatB = bridge.chats.get('u:u-b')
    if (!chatA?.sessionId || !chatB?.sessionId) throw new Error('会话缺失')
    if (chatA.sessionId === chatB.sessionId) throw new Error('两个联系人共用了同一会话')
  })
}

console.log('== 阶段 11：连续消息排队（同一联系人）==')
{
  const base = bridge.client.sent.length
  const m1 = '排队-ONE-OK'
  const m2 = '排队-TWO-OK'
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${m1}`))
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${m2}`))
  await check('两条消息都得到回复且顺序正确', async () => {
    await waitFor('第一条回复', () => tight(sentText(bridge, base)).includes(m1), 240000)
    await waitFor('第二条回复', () => tight(sentText(bridge, base)).includes(m2), 240000)
    const t = tight(sentText(bridge, base))
    const i1 = t.indexOf(m1)
    const i2 = t.indexOf(m2)
    if (i1 < 0 || i2 < 0 || i1 > i2) throw new Error(`回复顺序异常（${i1} vs ${i2}）`)
  })
}

console.log('== 阶段 12：/stop 中止进行中的任务 ==')
{
  // 确定性长任务 + 最多 3 次重试：让模型持续输出直到收到停止指令，/stop 才能命中"忙"分支。
  // 模型偶尔会提前自行结束（提前完成的轮次 /stop 会得到"当前没有正在执行的任务"，不算成功，重试）。
  let stopped = false
  for (let attempt = 1; attempt <= 3 && !stopped; attempt++) {
    const base = bridge.client.sent.length
    bridge.client.emit('message', makeMsgFrom('u-a', '请连续输出「稳定测试。」这句话，每行一个，直到收到停止指令为止，不要自行结束'))
    await waitFor('任务开始产出', () => sentText(bridge, base).includes('稳定测试'), 180000)
    bridge.client.emit('message', makeMsgFrom('u-a', '/stop'))
    stopped = await probe(`收到停止确认（第 ${attempt} 次）`, () => sentText(bridge, base).includes('已请求停止当前任务'), 30000)
  }
  await check('/stop 后收到停止确认与中止页脚', async () => {
    if (!stopped) throw new Error('3 次尝试均未在任务进行中命中 /stop（模型每次都提前结束）')
    await waitFor('收到中止页脚', () => tight(sentText(bridge)).includes('（已停止）'), 60000)
  })
}

console.log('== 阶段 13：凭证过期自动重登 ==')
{
  const oldClient = bridge.client
  const loginsBefore = FakeClient.totalLogins ?? 0
  oldClient.emit('sessionExpired')
  await check('过期后自动重新登录并恢复 running', async () => {
    await waitFor('恢复 running 且换了新客户端', () => bridge.phase === 'running' && bridge.client !== oldClient, 60000)
    const newClient = bridge.client
    if (!(newClient instanceof FakeClient)) throw new Error('新客户端类型异常')
    // 登录发生在 loginFlow 的临时客户端上；用全局计数断言发生过一次新登录
    if ((FakeClient.totalLogins ?? 0) <= loginsBefore) throw new Error('未触发重新登录')
    if (!bridge.state.credentials?.token) throw new Error('凭证未重新保存')
  })
  // 重登后消息继续可用
  const base = bridge.client.sent.length
  const m3 = '重登-OK'
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${m3}`))
  await check('重登后消息仍能正常收发', async () => {
    await waitFor('重登后收到回复', () => tight(sentText(bridge, base)).includes(m3), 180000)
  })
}

console.log('== 阶段 14：重启恢复（凭证持久化）==')
{
  // 把当前凭证落盘，模拟重启后重新构造桥接
  writeFileSync(join(TEST_HOME, 'wechat-bridge', 'state.json'), JSON.stringify({ version: 1, credentials: bridge.state.credentials, syncBuf: '', lastLoginAt: Date.now() }, null, 2))
  const bridge2 = new WeChatBridge(ctx, {
    enabled: true, token: '', accountId: '', baseUrl: 'https://example.invalid',
    allowFrom: ['*'], workDir: WORK_DIR, blockLinks: true, streaming: true,
    idleTimeoutMins: 0, maxReplyChars: 1500, loginCooldownSecs: 1, singleton: false
  }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridge2.start()
  await check('重启后直接用已保存凭证进入 running（无需重新登录）', async () => {
    await waitFor('进入 running', () => bridge2.phase === 'running' && bridge2.client instanceof FakeClient, 15000)
    if (bridge2.client.loginCalls > 0) throw new Error('重启后不应触发重新登录')
  })
  await bridge2.dispose()
}

console.log('== 阶段 15：非流式整段发送 ==')
{
  const base = bridge.client.sent.length
  bridge.config.streaming = false
  const m4 = '整段-OK'
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${m4}`))
  await check('streaming=false 时整段回复', async () => {
    await waitFor('收到整段回复', () => tight(sentText(bridge, base)).includes(m4), 180000)
  })
  bridge.config.streaming = true
}

console.log('== 阶段 16：fiber 卸载时资源清理（ctx.effect 生命周期）==')
{
  setClientFactoryForTests(FakeClient)
  // 标记已存在实例，只检查本次新创建的
  for (const c of FakeClient.instances) c.preExisting = true
  const testConfig = { ...bridge.config, token: '', accountId: '' }
  // 走真实插件入口 apply()，挂到独立 fiber（inject 与生产一致）
  const fiber = ctx.plugin({ inject: ['timer', 'agents', 'sessions', 'tools'], apply: (c) => apply(c, testConfig) })
  await fiber // 等待 fiber 加载完成
  await waitFor('新实例进入运行态', () => [...FakeClient.instances].some((c) => !c.preExisting && c.started), 15000)
  const scoped = [...FakeClient.instances].filter((c) => !c.preExisting && c.started && !c.stopped)
  if (scoped.length === 0) throw new Error('未发现由 apply 创建的运行中客户端')
  await check('专属文件工具注册成功（无 output 声明错误）', async () => {
    const logFile = join(TEST_HOME, 'wechat-bridge', 'bridge.log')
    if (!existsSync(logFile)) throw new Error('测试桥接日志不存在')
    const content = readFileSync(logFile, 'utf8')
    const idx = content.lastIndexOf('已注册微信专属工具')
    if (idx < 0) throw new Error(`工具注册日志缺失：${content.slice(-300)}`)
    if (content.slice(idx).includes('工具注册失败')) throw new Error(`本轮运行仍有注册失败：${content.slice(idx)}`)
  })
  await fiber.dispose()
  await check('卸载后该 fiber 创建的客户端全部停止（无泄漏）', async () => {
    await waitFor('客户端停止', () => scoped.every((c) => c.stopped), 10000)
  })
}

console.log('== 阶段 17：流式文本消毒（工具 XML 与思考块剥离）==')
await check('消毒器剥离工具调用 XML 与思考块', async () => {
  const s = createStreamSanitizer()
  // 模拟真实分片：标签跨片、嵌套工具调用、思考块
  let out = ''
  out += s.feed('我先看看目录。 <tool_calls>')
  out += s.feed('<invoke name="exec"> <param')
  out += s.feed('eter name="cmd">dir</parameter> </invoke>')
  out += s.feed('</tool_calls> 目录里有这些文件。 <zhimayc-think>')
  out += s.feed('用户想了解目录内容。 </zhimayc-think> 好的，我可以帮你。')
  out += s.flush()
  if (out.includes('<')) throw new Error(`仍有标记泄漏：${JSON.stringify(out)}`)
  if (!out.includes('我先看看目录。')) throw new Error('丢失正文开头')
  if (!out.includes('目录里有这些文件。')) throw new Error('丢失正文中段')
  if (!out.includes('好的，我可以帮你。')) throw new Error('丢失正文结尾')
  if (out.includes('dir')) throw new Error(`工具参数泄漏：${JSON.stringify(out)}`)
  if (out.includes('用户想了解')) throw new Error(`思考内容泄漏：${JSON.stringify(out)}`)
})

await check('消毒器跨片标签不误伤普通尖括号文本', async () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('比较 1 <')
  out += s.flush()
  out += s.feed('2 是对的') // "<" 后面不是已知标签 → 应保留
  out += s.flush()
  if (!out.includes('1 <2')) throw new Error(`普通尖括号被误删：${JSON.stringify(out)}`)
})

await check('消毒器剥离 bash 工具标签（本环境实测格式）', async () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('让我用工具查询：<bash>')
  out += s.feed('curl -s --max-time 20 "https://wttr.in/Shanghai"')
  out += s.feed('</bash> 查询完成，结果是晴天。')
  out += s.flush()
  if (out.includes('curl')) throw new Error(`bash 工具内容泄漏：${JSON.stringify(out)}`)
  if (!out.includes('查询完成，结果是晴天。')) throw new Error('丢失正文')
  if (!out.includes('让我用工具查询：')) throw new Error('丢失工具前正文')
})

console.log('== 阶段 18：单例互斥（第二个实例自动停用）==')
{
  const bridgeA = new WeChatBridge(ctx, { ...bridge.config, singleton: true }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeA.start()
  await waitFor('A 进入运行态', () => bridgeA.phase === 'running' && bridgeA.client instanceof FakeClient, 15000)
  const bridgeB = new WeChatBridge(ctx, { ...bridge.config, singleton: true }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeB.start()
  await check('B 检测到锁后自动停用、不建立客户端', async () => {
    if (!bridgeB.disposed) throw new Error('B 未停用')
    if (bridgeB.client !== null) throw new Error('B 仍建立了客户端')
    if (!bridgeA.client || bridgeA.disposed) throw new Error('A 被误伤')
  })
  await bridgeA.dispose()
  await bridgeB.dispose()
  // 释放后新实例可正常启动
  const bridgeC = new WeChatBridge(ctx, { ...bridge.config, singleton: true }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeC.start()
  await check('锁释放后新实例可正常接管', async () => {
    await waitFor('C 进入运行态', () => bridgeC.phase === 'running' && bridgeC.client instanceof FakeClient, 15000)
    if (bridgeC.disposed) throw new Error('C 被误停用')
  })
  await bridgeC.dispose()
}

console.log('== 阶段 19：override.json 白名单分级 + 管理员鉴权（含热加载）==')
{
  const ovFile = join(TEST_HOME, 'wechat-bridge', 'override.json')
  writeFileSync(ovFile, JSON.stringify({ allowFrom: ['u-admin'], admins: ['u-admin'] }, null, 2))
  const bridgeO = new WeChatBridge(ctx, { ...bridge.config, singleton: false }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeO.start()
  await waitFor('override 桥接进入运行态', () => bridgeO.phase === 'running' && bridgeO.client instanceof FakeClient, 15000)

  const baseO = bridgeO.client.sent.length
  const mA = '白名单-OA-OK'
  bridgeO.client.emit('message', makeMsgFrom('u-admin', `请只回复下面这行文字：${mA}`))
  await check('白名单内联系人正常收发', async () => {
    await waitFor('收到回复', () => tight(sentText(bridgeO, baseO)).includes(mA), 180000)
  })

  await check('白名单外联系人被忽略', async () => {
    const before = bridgeO.client.sent.length
    bridgeO.client.emit('message', makeMsgFrom('u-other', '白名单外的人发消息'))
    await sleep(3000)
    if (bridgeO.client.sent.length !== before) throw new Error('白名单外消息未被忽略')
  })

  await check('管理员控制命令可用、非管理员被拒（热加载）', async () => {
    const before = bridgeO.client.sent.length
    bridgeO.client.emit('message', makeMsgFrom('u-admin', '/new'))
    await waitFor('管理员 /new 回复', () => sentText(bridgeO, before).includes('已开始新会话'), 30000)
    // 热加载：把 u-other 加入白名单（但仍非管理员）
    writeFileSync(ovFile, JSON.stringify({ allowFrom: ['u-admin', 'u-other'], admins: ['u-admin'] }, null, 2))
    await sleep(7000) // 等待 refreshOverride 热加载
    const before2 = bridgeO.client.sent.length
    bridgeO.client.emit('message', makeMsgFrom('u-other', '/new'))
    await waitFor('非管理员 /new 被拒', () => sentText(bridgeO, before2).includes('仅管理员可用'), 30000)
  })

  // 清理：删除 override.json（热加载应回退到 patch 配置）
  if (existsSync(ovFile)) unlinkSync(ovFile)
  await sleep(7000)
  await check('override.json 删除后回退 patch 配置', async () => {
    // 直接断言回退后的生效状态（消息通路已在前面阶段覆盖）
    if (!bridgeO.effectiveAllowFrom().includes('*')) throw new Error(`回退失败：${JSON.stringify(bridgeO.effectiveAllowFrom())}`)
    if (bridgeO.effectiveAdmins().length !== 0) throw new Error(`admins 回退失败：${JSON.stringify(bridgeO.effectiveAdmins())}`)
  })
  await bridgeO.dispose()
}

console.log('== 阶段 20：会话持久化（重启后恢复上下文）==')
{
  const bridgeP1 = new WeChatBridge(ctx, { ...bridge.config, singleton: false }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeP1.start()
  await waitFor('P1 进入运行态', () => bridgeP1.phase === 'running' && bridgeP1.client instanceof FakeClient, 15000)
  const baseP1 = bridgeP1.client.sent.length
  const mP1 = '持久-P1-OK'
  bridgeP1.client.emit('message', makeMsgFrom('u-x', `请只回复下面这行文字：${mP1}`))
  await waitFor('P1 收到回复', () => tight(sentText(bridgeP1, baseP1)).includes(mP1), 180000)
  const chatP1 = bridgeP1.chats.get('u:u-x')
  const sessionP1 = chatP1?.sessionId
  if (!sessionP1) throw new Error('P1 未创建会话')
  const indexFile = join(TEST_HOME, 'wechat-bridge', 'chats.json')
  await check('会话索引已落盘且保留 contextToken', async () => {
    if (!existsSync(indexFile)) throw new Error('chats.json 不存在')
    const idx = JSON.parse(readFileSync(indexFile, 'utf8'))
    if (idx['u:u-x']?.sessionId !== sessionP1) throw new Error('索引中无该会话')
    if (idx['u:u-x']?.contextToken !== 'ctx-1') throw new Error(`contextToken 未持久化：${JSON.stringify(idx['u:u-x'])}`)
  })
  await bridgeP1.dispose()

  const bridgeP2 = new WeChatBridge(ctx, { ...bridge.config, singleton: false }, { info: () => {}, warn: () => {}, error: () => {} }, FakeClient)
  await bridgeP2.start()
  await waitFor('P2 进入运行态', () => bridgeP2.phase === 'running' && bridgeP2.client instanceof FakeClient, 15000)
  const baseP2 = bridgeP2.client.sent.length
  const mP2 = '持久-P2-OK'
  bridgeP2.client.emit('message', makeMsgFrom('u-x', `请只回复下面这行文字：${mP2}`))
  await check('重启后恢复同一会话（sessionId 不变）', async () => {
    await waitFor('P2 收到回复', () => tight(sentText(bridgeP2, baseP2)).includes(mP2), 180000)
    const chatP2 = bridgeP2.chats.get('u:u-x')
    if (!chatP2?.sessionId) throw new Error('P2 无会话')
    if (chatP2.sessionId !== sessionP1) throw new Error(`会话未恢复：${chatP2.sessionId} ≠ ${sessionP1}`)
  })
  await bridgeP2.dispose()
  // 清理索引，避免影响后续
  if (existsSync(indexFile)) unlinkSync(indexFile)
}

console.log('== 阶段 21：微信图片接收（下载到工作目录并交给 AI）==')
{
  const base = bridge.client.sent.length
  const mImg = '图测-OK'
  const imgMsg = makeMsg(`请只回复下面这行文字：${mImg}`, {
    item_list: [
      { type: 1, text_item: { text: `请只回复下面这行文字：${mImg}` } },
      { type: 2, image_item: { aeskey: 'AAECAwQFBgcICQoLDA0ODw==' } }
    ]
  })
  bridge.client.emit('message', imgMsg)
  await check('图片消息：回执 + 文件落盘 + AI 回复', async () => {
    await waitFor('收到图片回执', () => sentText(bridge, base).includes('收到 1 张图片'), 60000)
    await waitFor('AI 回复到达', () => tight(sentText(bridge, base)).includes(mImg), 240000)
    const files = existsSync(WORK_DIR) ? (await import('node:fs')).readdirSync(join(WORK_DIR, 'wechat-attachments')).filter((f) => f.startsWith('wechat-img-')) : []
    if (files.length === 0) throw new Error('图片文件未落盘')
    const saved = (await import('node:fs')).readFileSync(join(WORK_DIR, 'wechat-attachments', files[0]))
    if (saved[0] !== 0x89 || saved[1] !== 0x50) throw new Error('落盘文件不是 PNG')
  })
}

console.log('== 阶段 22：定时任务（cron，override.json 热加载）==')
await check('cron 解析与下一次触发时刻计算', async () => {
  const { parseCron, nextCronAfter } = await import(new URL('../lib/index.js', import.meta.url))
  const cron = parseCron('0 7 * * *')
  if (!cron) throw new Error('解析失败')
  const base = new Date('2026-08-15T06:59:00')
  const next = nextCronAfter(cron, base.getTime())
  const d = new Date(next)
  if (d.getHours() !== 7 || d.getMinutes() !== 0) throw new Error(`期望 07:00，实际 ${d}`)
  const cronEveryMin = parseCron('* * * * *')
  const next2 = new Date(nextCronAfter(cronEveryMin, Date.now()))
  if (next2.getTime() <= Date.now()) throw new Error('每分钟 cron 的下一时刻应在未来')
})
{
  const ovFile = join(TEST_HOME, 'wechat-bridge', 'override.json')
  const before = bridge.client.sent.length
  writeFileSync(ovFile, JSON.stringify({
    jobs: [
      { id: 't1', cron: '* * * * *', prompt: '请只回复下面这行文字：定时-OK', to: 'u-fake' }
    ]
  }, null, 2))
  await check('定时任务按 cron 触发并回传结果', async () => {
    await waitFor('收到定时任务回复', () => tight(sentText(bridge, before)).includes('定时-OK'), 200000)
  })
  if (existsSync(ovFile)) unlinkSync(ovFile)
  await sleep(7000)
}

console.log('== 阶段 23：正在输入状态提示（typing）==')
{
  const before = bridge.client.sent.length
  const mT = '输入中-OK'
  bridge.client.emit('message', makeMsgFrom('u-a', `请只回复下面这行文字：${mT}`))
  await check('思考时发送 typing ON、结束发送 OFF', async () => {
    await waitFor('收到回复', () => tight(sentText(bridge, before)).includes(mT), 180000)
    const events = bridge.client.typingEvents ?? []
    const onCount = events.filter((e) => e.status === 1).length
    const offCount = events.filter((e) => e.status === 2).length
    if (onCount < 1) throw new Error(`未见 typing ON（事件：${JSON.stringify(events)}）`)
    if (offCount < 1) throw new Error(`未见 typing OFF（事件：${JSON.stringify(events)}）`)
  })
}

console.log('== 阶段 25：文件回传（outbox 自动发送）==')
{
  const chatA = bridge.chats.get('u:u-a')
  if (!chatA) throw new Error('u-a 会话不存在')
  const dir = bridge.outboxDirFor(chatA.key)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'test-report.txt'), 'hello from outbox')
  const beforeMedia = bridge.client.mediaSent?.length ?? 0
  await check('outbox 文件自动发送并移入 sent', async () => {
    await waitFor('文件发送', () => (bridge.client.mediaSent?.length ?? 0) > beforeMedia, 15000)
    const last = bridge.client.mediaSent[bridge.client.mediaSent.length - 1]
    if (!last.filePath.endsWith('test-report.txt')) throw new Error(`发送文件异常：${last.filePath}`)
    if (!existsSync(join(dir, 'sent', 'test-report.txt'))) throw new Error('文件未移入 sent/')
  })
}

console.log('== 阶段 26：群聊（@机器人 触发）==')
{
  const before = bridge.client.sent.length
  // 群内未 @ 的消息：不应产生任何回复
  bridge.client.emit('message', makeMsg('群里闲聊一下', { group_id: 'g-test', from_user_id: 'u-a', to_user_id: 'g-test', context_token: 'ctx-g' }))
  await sleep(2500)
  await check('群内未 @ 的消息不回复', async () => {
    if (bridge.client.sent.length !== before) throw new Error(`意外回复：${sentText(bridge, before)}`)
  })
  // @ 开头：应回复，且回传目标为群 ID
  const mG = '群-OK'
  bridge.client.emit('message', makeMsg(`@机器人 请只回复下面这行文字：${mG}`, { group_id: 'g-test', from_user_id: 'u-a', to_user_id: 'g-test', context_token: 'ctx-g2' }))
  await check('群内 @机器人 的消息得到回复且回传给群', async () => {
    await waitFor('收到群回复', () => tight(sentText(bridge, before)).includes(mG), 180000)
    const last = bridge.client.sent[bridge.client.sent.length - 1]
    if (last.to !== 'g-test') throw new Error(`回传目标异常：${last.to}`)
    if (!bridge.chats.get('g:g-test')?.agent) throw new Error('群会话 Agent 未创建')
  })
}

console.log('== 阶段 27：入站文件接收 ==')
{
  const before = bridge.client.sent.length
  const mF = '文件-OK'
  const fileItem = { type: 4, file_item: { file_name: '说明.txt', len: '19' } }
  bridge.client.emit('message', makeMsg(`请只回复下面这行文字：${mF}`, {
    from_user_id: 'u-a',
    item_list: [{ type: 1, text_item: { text: `请只回复下面这行文字：${mF}` } }, fileItem],
    context_token: 'ctx-f'
  }))
  await check('文件下载回执 + 落盘 + AI 回复', async () => {
    await waitFor('收到文件回执', () => sentText(bridge, before).includes('📎 收到 1 个文件'), 30000)
    await waitFor('收到 AI 回复', () => tight(sentText(bridge, before)).includes(mF), 180000)
    const fs = await import('node:fs')
    const dir = join(WORK_DIR, 'wechat-attachments')
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('wechat-file-'))
    if (files.length === 0) throw new Error('文件未落盘')
    const content = fs.readFileSync(join(dir, files[0]), 'utf8')
    if (!content.includes('hello file content')) throw new Error('落盘内容异常')
  })
}

console.log('== 阶段 28：专属文件交付工具（wechat_send_file 底层链路）==')
{
  const chatA = bridge.chats.get('u:u-a')
  if (!chatA) throw new Error('u-a 会话不存在')
  const beforeMedia = bridge.client.mediaSent?.length ?? 0
  const done = await bridge.deliverFile(chatA, 'report.html', '<html>测试报告</html>')
  await check('wechat_send_file 写入 outbox 并自动发送', async () => {
    const sentDir = join(dirname(done.file), 'sent')
    const still = existsSync(done.file)
    const moved = existsSync(join(sentDir, basename(done.file)))
    if (!still && !moved) throw new Error('文件既不在 outbox 也不在 sent')
    await waitFor('文件自动发送', () => (bridge.client.mediaSent?.length ?? 0) > beforeMedia, 15000)
    const last = bridge.client.mediaSent[bridge.client.mediaSent.length - 1]
    if (!last.filePath.includes('report.html')) throw new Error(`发送文件异常：${last.filePath}`)
  })
  await check('wechat_send_local_file 拒绝工作目录外文件', async () => {
    let rejected = false
    try { await bridge.deliverLocalFile(chatA, 'C:/Windows/win.ini') } catch { rejected = true }
    if (!rejected) throw new Error('未拒绝工作目录外文件')
  })
}

console.log('== 阶段 9：清理 ==')
await bridge.dispose()
await ctx.fiber.dispose()
await check('正常关闭（dispose 无异常）', async () => { /* 已执行 */ })

console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`)
if (failed > 0) {
  for (const f of failures) console.log(`失败详情：${f.desc}\n  ${f.error?.stack ?? f.error}`)
}
process.exit(failed > 0 ? 1 : 0)
