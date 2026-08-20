// M2 冒烟测试：路由决策表全分支（mock fetchImpl 模拟 OpenViking provider）。
// 用法：node --import ./test/smoke-stub.mjs test/smoke-m2.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const smokeHome = mkdtempSync(join(tmpdir(), 'wb-home-'))
process.env.DSH_SMOKE_HOME = smokeHome

const { WeChatBridge, buildAnchorText, hasWorkIntent, cosine } = await import('../lib/index.js')

const sent = []
let scores = { A: 0, B: 0 } // mock 相似度，按消息文本控制
const writtenUris = []
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') {
      return { list: () => [{ path: 'D:/fake/A', name: '项目A' }, { path: 'D:/fake/B', name: '项目B' }] }
    }
    throw new Error('no service')
  }
}
const log = { info() {}, warn() {}, error() {} }
const bridge = new WeChatBridge(fakeCtx, {
  allowFrom: ['*'],
  routerEnabled: true,
  routerProvider: 'openviking',
  routerOpenvikingBaseUrl: 'http://mock:1',
  routerMargin: 0.08,
  routerEnter: 0.62,
  routeMode: 'auto'
}, log)
bridge.reply = async (chat, text) => { sent.push(text) }
// mock HTTP：content/write 记录 URI；search/find 按项目返回预设 score
bridge.fetchImpl = async (url) => {
  const u = String(url)
  if (u.endsWith('/api/v1/content/write') || u.endsWith('/api/v1/content/reindex')) {
    return { ok: true, json: async () => ({ status: 'ok' }) }
  }
  if (u.endsWith('/api/v1/search/find')) {
    // 由最近一次请求体的 target_uri 反推项目（hash 不可逆，用调用序号模拟：按 find 次序 A、B 交替）
    bridge.__findCount = (bridge.__findCount ?? 0) + 1
    const isA = bridge.__findCount % 2 === 1
    const score = isA ? scores.A : scores.B
    return { ok: true, json: async () => ({ status: 'ok', result: { resources: [{ score }] } }) }
  }
  return { ok: false, status: 404 }
}

const chat = bridge.ensureChat('u:t2', 't2')
chat.history = [{ role: 'user', text: '之前在项目A修过 bug' }]

// 0) 纯函数
assert.ok(hasWorkIntent('来修一下登录 bug'))
assert.ok(!hasWorkIntent('今天天气不错'))
assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
assert.ok(cosine([1, 0], [0, 1]) === 0)

// 1) 都低于阈值 → 留日常，不切、无菜单
sent.length = 0
bridge.__findCount = 0
scores = { A: 0.3, B: 0.2 }
assert.equal(await bridge.routeMessage(chat, '今天吃什么'), null)
assert.equal(bridge.getBinding(chat).projectId, '__daily__')
assert.equal(bridge.menus.size, 0)
assert.equal(sent.length, 0)

// 2) 高置信（top1 ≥ enter 且差 > margin）→ 自动切项目 + 标头
sent.length = 0
bridge.__findCount = 0
scores = { A: 0.9, B: 0.3 }
assert.equal(await bridge.routeMessage(chat, '项目A的部署报错了'), null)
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/A')
assert.ok(sent.some((t) => t.includes('已进入') && t.includes('项目A')), '应带切入标头')
assert.ok(sent.some((t) => t.includes('/home 回日常')), '应带可撤销提示')

// 3) 手动切换后 60s 静默：路由不动作
sent.length = 0
bridge.__findCount = 0
scores = { A: 0.2, B: 0.95 }
assert.equal(await bridge.routeMessage(chat, '来跑项目B的测试'), null)
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/A', '静默窗口内不得切走')
assert.equal(sent.length, 0)
bridge.routeSilentUntil = 0 // 解除静默

// 4) 项目中：其他项目高相似 + 工作意图 → 不切 + 建议菜单
sent.length = 0
bridge.__findCount = 0
assert.equal(await bridge.routeMessage(chat, '来跑项目B的测试'), null)
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/A', '项目中绝不静默切走')
const menu1 = bridge.activeMenu(chat)
assert.equal(menu1?.kind, 'route-suggest')
assert.ok(sent.some((t) => t.includes('这像') && t.includes('项目B')))
// 选 1 切过去
await bridge.handleMenuSelection(chat, 1)
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/B')

// 5) 项目中：纯闲聊（低相似/无工作意图）→ 原样投递，无建议
sent.length = 0
bridge.__findCount = 0
scores = { A: 0.9, B: 0.95 }
assert.equal(await bridge.routeMessage(chat, '哈哈哈今天好累'), null) // 无工作意图 → 不建议
assert.equal(bridge.menus.size, 0)

// 6) 日常中歧义（top1−top2 ≤ margin）→ 三选一菜单，消息留日常
await bridge.switchProject(chat, '__daily__')
bridge.routeSilentUntil = 0
sent.length = 0
bridge.__findCount = 0
scores = { A: 0.9, B: 0.88 }
await bridge.routeMessage(chat, '把那个东西修一下')
const menu2 = bridge.activeMenu(chat)
assert.equal(menu2?.kind, 'route-choice')
assert.equal(menu2.items.length, 3)
assert.ok(sent.some((t) => t.includes('留日常')))
// 选 3 留日常
await bridge.handleMenuSelection(chat, 3)
assert.equal(bridge.getBinding(chat).projectId, '__daily__')

// 7) stay 钉住 → 路由静默
const binding = bridge.getBinding(chat)
binding.stayUntil = Date.now() + 3600 * 1000
bridge.__findCount = 0
scores = { A: 0.95, B: 0.2 }
assert.equal(await bridge.routeMessage(chat, '项目A 部署'), null)
assert.equal(bridge.getBinding(chat).projectId, '__daily__')
binding.stayUntil = null

// 8) provider 失败 → 降级直通
bridge.fetchImpl = async () => { throw new Error('network down') }
bridge.__findCount = 0
assert.equal(await bridge.routeMessage(chat, '项目A 部署'), null)
assert.equal(bridge.getBinding(chat).projectId, '__daily__', '失败不得改变绑定')

// 9) routeMode=ask：高置信也先问
bridge.fetchImpl = async (url) => {
  if (String(url).endsWith('/api/v1/content/write') || String(url).endsWith('/api/v1/content/reindex')) return { ok: true, json: async () => ({}) }
  bridge.__findCount = (bridge.__findCount ?? 0) + 1
  return { ok: true, json: async () => ({ status: 'ok', result: { resources: [{ score: bridge.__findCount % 2 === 1 ? 0.95 : 0.2 }] } }) }
}
bridge.config.routeMode = 'ask'
bridge.__findCount = 0
sent.length = 0
await bridge.routeMessage(chat, '项目A 部署')
const menu3 = bridge.activeMenu(chat)
assert.equal(menu3?.kind, 'route-choice', 'ask 模式应发菜单确认')
await bridge.handleMenuSelection(chat, 1)
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/A')

// 10) buildAnchorText：README 前 2000 字
{
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-'))
  writeFileSync(join(dir, 'README.md'), '# 项目A\n这是项目A的说明文档。')
  const anchor = buildAnchorText(dir, [{ role: 'user', text: '修 bug' }])
  assert.ok(anchor.includes('项目A的说明文档'))
  assert.ok(anchor.includes('修 bug'))
  rmSync(dir, { recursive: true, force: true })
}

// 11) 配置关闭（provider=off）→ 直通
bridge.config.routerProvider = 'off'
assert.equal(await bridge.routeMessage(chat, '随便什么'), null)

rmSync(smokeHome, { recursive: true, force: true })
console.log('SMOKE-M2 OK — 路由决策表全分支断言通过')
