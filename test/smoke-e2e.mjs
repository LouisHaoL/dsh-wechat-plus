// M3 E2E 测试（SPEC 第 5 节场景 1~8）：mock iLink 消息 + mock agents/sessionQuery/workspaceRegistry
// 服务，从 onMessage 入口走完整入站链路（命令拦截 → 路由钩子 → 会话恢复/新建 → followup → drain 流式回传）。
// 用法：node --import ./test/smoke-stub.mjs test/smoke-e2e.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageType, MessageItemType } from 'wechat-ilink-client'

// 隔离 DSH_HOME（必须在 import lib 之前）：状态目录 = smokeHome/wechat-plus
const smokeHome = mkdtempSync(join(tmpdir(), 'wb-e2e-home-'))
process.env.DSH_SMOKE_HOME = smokeHome

const { WeChatBridge } = await import('../lib/index.js')

// ===== mock 服务树 =====
const PROJECTS = [
  { path: 'D:/fake/A', name: '项目A' },
  { path: 'D:/fake/B', name: '项目B' }
]
// 会话库（真实 API 形态：searchSessions({query, sessionFilters, cursor}) → {items:[{header:{id,cwd},title}], nextCursor}）
const sessionStore = []
for (let i = 1; i <= 9; i++) {
  sessionStore.push({ header: { id: `sess-a${i}`, cwd: 'D:/fake/A', updatedAt: 1000 * i, createdAt: 1000 * i }, title: `会话A${i}` })
}
sessionStore.push({ header: { id: 'sess-b1', cwd: 'D:/fake/B', updatedAt: 500, createdAt: 500 }, title: '会话B1' })
const resumableIds = new Set(sessionStore.map((s) => s.header.id)) // create 出来的会话也加入

const createCalls = []
const resumeCalls = []
const followups = []
function mkAgent(sessionId) {
  return {
    session: { id: sessionId, seq: 0, events: [] },
    status: 'idle',
    cancel() {},
    followup(u) {
      const text = u?.content?.[0]?.text ?? ''
      this.session.events.push(
        { type: 'turn/start' },
        { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: `（AI回执）${text.slice(0, 12)}` } } },
        { type: 'turn/end', data: { reason: { kind: 'stop' } } }
      )
      followups.push(text)
    }
  }
}
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => PROJECTS }
    if (name === 'sessionQuery') {
      return {
        // 真实 DSH API：每页 6 条 + nextCursor（顺带压测 allSessionRecords 的游标循环）
        searchSessions: async ({ cursor } = {}) => {
          const start = cursor == null ? 0 : Number(cursor)
          const items = sessionStore.slice(start, start + 6).map((s) => ({ header: s.header, title: s.title }))
          const next = start + 6 < sessionStore.length ? String(start + 6) : null
          return { items, nextCursor: next }
        }
      }
    }
    if (name === 'agents') {
      return {
        create: async (options) => {
          createCalls.push(options)
          resumableIds.add(String(options.sessionId))
          return { agent: mkAgent(options.sessionId), dispose: async () => {} }
        },
        resume: async (options) => {
          const sid = String(options.resumeSessionId ?? '')
          if (!resumableIds.has(sid)) throw new Error(`unknown session ${sid}`)
          resumeCalls.push(options)
          return { agent: mkAgent(sid), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
}

const sent = []
const log = { info() {}, warn() {}, error() {} }
const config = {
  allowFrom: ['*'],
  maxReplyChars: 200,
  usageFooter: false,
  typing: false,
  waitNoteSecs: 0,
  routerEnabled: true,
  routerProvider: 'openviking',
  routerOpenvikingBaseUrl: 'http://mock:1',
  routerMargin: 0.08,
  routerEnter: 0.62,
  routeMode: 'auto'
}
const bridge = new WeChatBridge(fakeCtx, config, log)
bridge.reply = async (chat, text) => { sent.push(text) }

// ===== mock embedding（OpenViking provider）：按 target_uri 精确回 score =====
// 锚点 URI 算法与 lib 内 anchorUriFor 一致：'viking' + '://' + resources/wechat-plus-route/<sha1 前 12>.md
// （拆开写以避免工具把完整 viking 虚拟路径当本地文件处理）
let scores = { A: 0.1, B: 0.1 }
let findCalls = 0
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex')
const anchorUri = (projectId) => 'viking' + '://resources/wechat-plus-route/' + sha1(projectId).slice(0, 12) + '.md'
bridge.fetchImpl = async (url, init) => {
  const u = String(url)
  if (u.endsWith('/api/v1/content/write') || u.endsWith('/api/v1/content/reindex')) {
    return { ok: true, json: async () => ({ status: 'ok' }) }
  }
  if (u.endsWith('/api/v1/search/find')) {
    findCalls++
    const body = JSON.parse(init?.body ?? '{}')
    const score = body.target_uri === anchorUri('D:/fake/A') ? scores.A : body.target_uri === anchorUri('D:/fake/B') ? scores.B : 0
    return { ok: true, json: async () => ({ status: 'ok', result: { resources: [{ score }] } }) }
  }
  return { ok: false, status: 404 }
}

// ===== 入站消息驱动：onMessage → opQueue → 手动 drain（tick 的等价物） =====
const KEY = 'u:e2e'
const TO = 'e2e'
let msgSeq = 0
async function send(text) {
  msgSeq++
  const chat = bridge.ensureChat(KEY, TO)
  await bridge.onMessage({
    message_type: MessageType.USER,
    from_user_id: TO,
    message_id: `m-${msgSeq}`,
    create_time_ms: Date.now(),
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }]
  })
  await chat.opQueue
  const cur = bridge.ensureChat(KEY, TO)
  if (cur.agent && !cur.tornDown) bridge.drain(cur, Date.now() + 1000) // 流式结算（等价 tick 到点）
  return cur
}
const lastSent = () => sent[sent.length - 1] ?? ''

// ===== 场景 1：新联系人默认落日常 → 发消息 → 回复正常 =====
{
  const chat = bridge.ensureChat(KEY, TO)
  assert.equal(bridge.getBinding(chat).projectId, '__daily__')
  createCalls.length = 0
  await send('你好，帮我记个事')
  assert.equal(createCalls.length, 1, '首条消息应新建 Agent')
  const cwd = String(createCalls[0].meta?.cwd ?? '').replaceAll('\\', '/')
  assert.ok(cwd.endsWith('.dsh/daily'), `新建会话 cwd 应为日常目录，实际 ${cwd}`)
  assert.ok(sent.some((t) => t.includes('（AI回执）你好')), '回复应正常回传')
  assert.ok(bridge.getBinding(chat).sessionByProject.__daily__.startsWith('wechat-'), 'daily 指针应指向新会话')
}

// ===== 场景 2：/projects → /project 2 → /sessions → 翻页 → 数字选择 → 后续消息 resume 正确会话 =====
{
  await send('/projects')
  assert.equal(bridge.activeMenu(bridge.ensureChat(KEY, TO))?.kind, 'projects')
  assert.ok(lastSent().includes('日常') && lastSent().includes('项目A'))

  sent.length = 0
  await send('/project 2') // 第 2 个 = 项目A
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, 'D:/fake/A')
  assert.ok(sent.some((t) => t.includes('已切换到【项目A】')), `应回复切换确认：${lastSent()}`)
  assert.ok(sent.some((t) => t.includes('《会话A9》')), '应落在最近活跃会话《会话A9》')

  sent.length = 0
  await send('/sessions') // A 项目 9 个会话 → 第 1 页 8 条
  const menu = bridge.activeMenu(bridge.ensureChat(KEY, TO))
  assert.equal(menu.kind, 'sessions')
  assert.ok(lastSent().includes('第 1/2 页'), '应显示分页 1/2')
  await send('n') // 下一页
  assert.ok(lastSent().includes('第 2/2 页'), 'n 应翻到第 2 页')
  await send('9') // 第 2 页里编号 9 = 《会话A1》（updatedAt 最旧）
  assert.ok(lastSent().includes('已切换：《会话A1》'), `应回显确认：${lastSent()}`)
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).sessionByProject['D:/fake/A'], 'sess-a1')

  // 关键词过滤
  await send('/sessions A3')
  assert.ok(lastSent().includes('《会话A3》') && !lastSent().includes('《会话A2》'), '关键词应过滤标题')

  // 后续消息进入所选会话：断言 resume 收到正确 sessionId + cwd
  resumeCalls.length = 0
  await send('继续修这个问题')
  assert.equal(resumeCalls.length, 1, '应恢复所选会话而非新建')
  assert.equal(String(resumeCalls[0].resumeSessionId), 'sess-a1')
  assert.equal(resumeCalls[0].meta?.cwd, 'D:/fake/A', 'resume 的 meta.cwd 应取该会话 header 的 cwd')
}

// ===== 场景 3：日常中发项目相关消息（mock 高相似）→ 自动切项目 + 标头 =====
{
  await send('/home')
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, '__daily__')
  bridge.routeSilentUntil = 0 // 手动切换的静默窗口手动解除
  sent.length = 0
  scores = { A: 0.95, B: 0.2 }
  resumeCalls.length = 0
  await send('项目A的部署报错了')
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, 'D:/fake/A', '应自动切入项目A')
  assert.ok(sent.some((t) => t.includes('[已进入【项目A】')), '应带切入标头')
  assert.ok(sent.some((t) => t.includes('↩ /home 回日常')), '应带可撤销提示')
  assert.equal(resumeCalls.length, 1, '切换后消息应落在项目A 的指针会话')
  assert.equal(String(resumeCalls[0].resumeSessionId), 'sess-a1')
  scores = { A: 0.1, B: 0.1 }
}

// ===== 场景 4：歧义消息 → 三选一菜单 → 选择生效 =====
{
  await send('/home')
  bridge.routeSilentUntil = 0
  sent.length = 0
  scores = { A: 0.9, B: 0.88 } // top1−top2 = 0.02 ≤ margin(0.08) → 歧义
  await send('把那个东西修一下')
  const menu = bridge.activeMenu(bridge.ensureChat(KEY, TO))
  assert.equal(menu?.kind, 'route-choice')
  assert.equal(menu.items.length, 3)
  assert.ok(sent.some((t) => t.includes('留日常')), `三选一菜单应含"留日常"选项：${sent.join('|')}`)
  await send('1') // 切到项目A
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, 'D:/fake/A', '选择 1 应切到项目A')
  scores = { A: 0.1, B: 0.1 }
}

// ===== 场景 5：/stay 后路由静默 =====
{
  await send('/home')
  await send('/stay 2')
  assert.ok(bridge.getBinding(bridge.ensureChat(KEY, TO)).stayUntil > Date.now(), '/stay 应设置钉住')
  sent.length = 0
  findCalls = 0
  scores = { A: 0.95, B: 0.2 }
  await send('项目A 部署')
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, '__daily__', 'stay 期间不得切换')
  assert.equal(findCalls, 0, 'stay 期间不应调用相似度服务')
  assert.ok(!sent.some((t) => t.includes('已进入')), 'stay 期间不得发切入标头')
  assert.ok(sent.some((t) => t.includes('（AI回执）')), '消息应正常投递日常')
  bridge.getBinding(bridge.ensureChat(KEY, TO)).stayUntil = null
  scores = { A: 0.1, B: 0.1 }
}

// ===== 场景 6：项目中聊其他项目（工作意图）→ 不切 + 建议 =====
{
  await send('/project 2') // 回项目A（指针 sess-a1）
  bridge.routeSilentUntil = 0
  sent.length = 0
  scores = { A: 0.3, B: 0.9 } // B > enter+迟滞 且工作意图 → 建议
  await send('来跑项目B的测试')
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, 'D:/fake/A', '项目中绝不静默切走')
  const menu = bridge.activeMenu(bridge.ensureChat(KEY, TO))
  assert.equal(menu?.kind, 'route-suggest')
  assert.ok(sent.some((t) => t.includes('这像【项目B】的活')), '应发切出建议')
  await send('2') // 就在这聊
  assert.equal(bridge.getBinding(bridge.ensureChat(KEY, TO)).projectId, 'D:/fake/A', '选 2 应留在当前项目')
  scores = { A: 0.1, B: 0.1 }
}

// ===== 场景 7：/history 脱敏与分段 =====
{
  const chat = bridge.ensureChat(KEY, TO)
  chat.history = [
    { role: 'user', text: '我的 API_KEY=sk-abcdefghijklmnop123456 请保管好' },
    { role: 'assistant', text: '已记录。Bearer Ya23.aB_cDefGh12345678 也一样' },
    { role: 'user', text: '手机号 13812345678，password=hunter2secret，普通句子应保留' }
  ]
  sent.length = 0
  await send('/history 3')
  assert.ok(sent.length >= 1, 'history 应有回复')
  const joined = sent.join('\n')
  assert.ok(!joined.includes('sk-abcdefghijklmnop123456'), 'sk- key 应脱敏')
  assert.ok(!joined.includes('Ya23.aB'), 'Bearer 应脱敏')
  assert.ok(!joined.includes('13812345678'), '手机号应脱敏')
  assert.ok(!joined.includes('hunter2secret'), 'password 赋值应脱敏')
  assert.ok(joined.includes('普通句子应保留'), '正常文本保留')

  // 分段：长历史 → 多段；超 20 段 → 截断提示
  chat.history = []
  for (let i = 0; i < 24; i++) {
    chat.history.push({ role: 'user', text: `第${i}轮 ${'内容'.repeat(120)}` })
    chat.history.push({ role: 'assistant', text: `回复${i} ${'答案'.repeat(120)}` })
  }
  sent.length = 0
  await send('/history 24')
  const histJoined = sent.join('\n')
  assert.ok(sent.length > 1, `长历史应分段发送（实际 ${sent.length} 段）`)
  assert.ok(histJoined.includes('已截断至 20 段'), `超过 20 段应提示截断：${histJoined.slice(-120)}`)
  // 用更小轮数可缩小范围
  sent.length = 0
  await send('/history 2')
  assert.ok(!sent.join('\n').includes('已截断'), '小范围不应触发截断提示')
}

// ===== 场景 8：重启恢复绑定 =====
{
  const before = JSON.parse(JSON.stringify(bridge.getBinding(bridge.ensureChat(KEY, TO))))
  assert.equal(before.projectId, 'D:/fake/A')
  assert.equal(before.sessionByProject['D:/fake/A'], 'sess-a1')

  const bridge2 = new WeChatBridge(fakeCtx, { ...config }, log)
  const sent2 = []
  bridge2.reply = async (chat, text) => { sent2.push(text) }
  const chat2 = bridge2.ensureChat(KEY, TO)
  const b2 = bridge2.getBinding(chat2)
  assert.deepEqual(JSON.parse(JSON.stringify(b2)), before, '重启后绑定应从磁盘完整恢复')

  // 恢复后首条 /status 校验
  await bridge2.handleCommand(chat2, '/status')
  assert.ok(sent2.join('\n').includes('项目：项目A'), `/status 应显示恢复后的项目：${sent2.join('|')}`)
  assert.ok(sent2.join('\n').includes('会话A1') || sent2.join('\n').includes('sess-a1'), '/status 应显示当前会话')
}

// ===== 兜底：状态文件落盘形态 =====
{
  const raw = JSON.parse(readFileSync(join(bridge.stateDir, 'bindings.json'), 'utf8'))
  assert.equal(raw[KEY].projectId, 'D:/fake/A')
  assert.equal(raw[KEY].sessionByProject['D:/fake/A'], 'sess-a1')
}

rmSync(smokeHome, { recursive: true, force: true })
console.log('SMOKE-E2E OK — SPEC 第 5 节场景 1~8 全部断言通过')
