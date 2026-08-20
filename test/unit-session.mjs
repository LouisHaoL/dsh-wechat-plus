// M3 单元测试补充（SPEC 第 5 节）：脱敏正则各形态、菜单 TTL/单活跃、绑定持久化往返、
// 路由阈值/迟滞/静默窗口边界值。依赖 smoke-stub（@deepseek-ai/* stub），CI 上需先 npm install。
// 用法：node --import ./test/smoke-stub.mjs test/unit-session.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`)
  }
}
console.log('== 会话管理单元测试 ==')

const smokeHome = mkdtempSync(join(tmpdir(), 'wb-unit-home-'))
process.env.DSH_SMOKE_HOME = smokeHome
const { WeChatBridge, redactText } = await import('../lib/index.js')

// ---------- 1) 脱敏正则：各类 secret 形态 ----------
await check('脱敏：sk- API key（16+ 位）', () => {
  assert.ok(!redactText('key 是 sk-abcdef0123456789abcd').includes('sk-abcdef'))
  // 不足 16 位的 sk- 短串不按该规则（避免误伤普通词）
  assert.ok(redactText('见 sk-short123 条目').includes('sk-short123'))
})
await check('脱敏：Bearer / Authorization 头', () => {
  assert.ok(!redactText('Bearer Ya23.aB_cDefGh12345678').includes('Ya23'))
  assert.ok(!redactText('Authorization: eyJhbGciOiJIUzI1NiJ9.payload').includes('eyJhbGci'))
  assert.ok(!redactText('authorization=xYz1234567890abc').includes('xYz1234567890abc'))
})
await check('脱敏：密码/密钥赋值（key: value 与 key=value，含驼峰/下划线变体）', () => {
  for (const line of [
    'password=hunter2secret',
    'PASSWORD: mySecretPass1',
    'api_key: abc123def456',
    'apiKey=ZZ99qq88ww77',
    'secret: s3cr3t-value',
    'access_token=ghp_abcdefghijklmnopqrst',
    'token: tok_1234567890abcdef'
  ]) {
    const out = redactText(line)
    const value = line.split(/[:=]/)[1]?.trim()
    if (value) assert.ok(!out.includes(value), `${line} 的值应脱敏，实际输出：${out}`)
  }
  assert.ok(redactText('password=hunter2secret').includes('***'))
})
await check('脱敏：≥40 位长随机串（hex/base62/base64）', () => {
  const hex = 'a'.repeat(64)
  const b62 = 'Ab1'.repeat(20) // 60 位
  assert.ok(!redactText(`commit ${hex}`).includes(hex))
  assert.ok(!redactText(`id=${b62}`).includes(b62))
})
await check('脱敏：中国大陆手机号（不误伤相邻数字）', () => {
  assert.ok(!redactText('联系 13812345678').includes('13812345678'))
  assert.ok(!redactText('15999999999').includes('15999999999'))
  assert.ok(redactText('号 138123456789').includes('138123456789'), '12 位数字不按手机号整体脱敏')
  assert.ok(redactText('编号 1381234567').includes('1381234567'), '10 位数字不误伤')
  assert.ok(redactText('12345678901').includes('12345678901'), '1 开头但非 1[3-9] 号段的 11 位数字不是手机号，应保留')
  // 12 开头不是 1[3-9]：应保留
  assert.ok(redactText('号 12312345678').includes('12312345678'), '非 1[3-9] 开头 11 位不脱敏')
})
await check('脱敏：正常文本不误伤', () => {
  const ok = '今天天气很好，我们讨论一下 README.md 和 package.json 的内容。长度不足的普通串 abc123 保持原样。'
  assert.equal(redactText(ok), ok)
  assert.ok(redactText('比较 1 < 2 且 x=3').includes('x=3'))
})

// ---------- 2) 菜单 TTL / 单活跃 / 失效选择 ----------
const stateDir = mkdtempSync(join(tmpdir(), 'wb-unit-state-'))
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => [{ path: 'D:/fake/A', name: '项目A' }, { path: 'D:/fake/B', name: '项目B' }] }
    throw new Error('no service')
  }
}
const log = { info() {}, warn() {}, error() {} }
const sent = []
const bridge = new WeChatBridge(fakeCtx, { allowFrom: ['*'] }, log)
bridge.stateDir = stateDir
bridge.bindings = {}
bridge.reply = async (chat, text) => { sent.push(text) }
const chat = bridge.ensureChat('u:unit', 'unit')

await check('菜单：单活跃（新菜单作废旧菜单）', () => {
  bridge.setMenu(chat, { kind: 'sessions', items: [], page: 1 })
  bridge.setMenu(chat, { kind: 'projects', items: [] })
  assert.equal(bridge.activeMenu(chat)?.kind, 'projects')
  assert.equal(bridge.menus.size, 1)
})
await check('菜单：TTL 过期后 activeMenu 返回 null 并清理', () => {
  bridge.setMenu(chat, { kind: 'sessions', items: [] })
  const menu = bridge.menus.get(chat.key)
  menu.expiresAt = Date.now() - 1 // 模拟 5 分钟过期
  assert.equal(bridge.activeMenu(chat), null)
  assert.equal(bridge.menus.size, 0)
})
await check('菜单：过期后选择 → 菜单已失效提示', async () => {
  bridge.setMenu(chat, { kind: 'sessions', items: [{ id: 's1', title: 't' }], page: 1 })
  bridge.menus.get(chat.key).expiresAt = Date.now() - 1
  sent.length = 0
  await bridge.handleMenuSelection(chat, 1)
  assert.ok(sent.some((t) => t.includes('菜单已失效')), `应提示失效：${sent.join('|')}`)
})
await check('菜单：选择编号越界 → 提示范围', async () => {
  bridge.setMenu(chat, { kind: 'sessions', items: [{ id: 's1', title: 't' }], page: 1 })
  sent.length = 0
  await bridge.handleMenuSelection(chat, 5)
  assert.ok(sent.some((t) => t.includes('1~1')), `应提示范围：${sent.join('|')}`)
  bridge.menus.delete(chat.key)
})

// ---------- 3) 绑定持久化往返 ----------
await check('绑定持久化：往返完整（多项目指针 + stay）', async () => {
  const b = bridge.getBinding(chat)
  b.projectId = 'D:/fake/B'
  b.sessionByProject = { __daily__: 'wechat-x1', 'D:/fake/A': 'sess-a', 'D:/fake/B': 'sess-b' }
  b.stayUntil = 1700000000000
  bridge.persistBindings()
  // 磁盘形态
  const raw = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'))
  assert.equal(raw['u:unit'].projectId, 'D:/fake/B')
  assert.equal(raw['u:unit'].sessionByProject['D:/fake/A'], 'sess-a')
  assert.equal(raw['u:unit'].stayUntil, 1700000000000)
  // 新实例（模拟重启）恢复
  const bridge2 = new WeChatBridge(fakeCtx, { allowFrom: ['*'] }, log)
  bridge2.stateDir = stateDir
  const b2 = bridge2.getBinding(bridge2.ensureChat('u:unit', 'unit'))
  assert.equal(b2.projectId, 'D:/fake/B')
  assert.deepEqual(b2.sessionByProject, { __daily__: 'wechat-x1', 'D:/fake/A': 'sess-a', 'D:/fake/B': 'sess-b' })
  assert.equal(b2.stayUntil, 1700000000000)
})
await check('绑定持久化：损坏 JSON → 回退默认（不抛错）', () => {
  const { writeFileSync: wf } = { writeFileSync }
  writeFileSync(join(stateDir, 'bindings.json'), '{broken json!!')
  const bridge3 = new WeChatBridge(fakeCtx, { allowFrom: ['*'] }, log)
  bridge3.stateDir = stateDir
  const b3 = bridge3.getBinding(bridge3.ensureChat('u:fresh', 'fresh'))
  assert.equal(b3.projectId, '__daily__')
  assert.deepEqual(b3.sessionByProject, {})
})

// ---------- 4) 路由阈值 / 迟滞 / 静默窗口边界值 ----------
const rbridge = new WeChatBridge(fakeCtx, {
  allowFrom: ['*'],
  routerEnabled: true,
  routerProvider: 'openviking',
  routerOpenvikingBaseUrl: 'http://mock:1',
  routerMargin: 0.08,
  routerEnter: 0.62,
  routeMode: 'auto'
}, log)
rbridge.stateDir = mkdtempSync(join(tmpdir(), 'wb-unit-route-'))
rbridge.bindings = {}
rbridge.reply = async (c, text) => { sent.push(text) }
const rchat = rbridge.ensureChat('u:route', 'route')
rchat.history = [{ role: 'user', text: '之前在项目A修过 bug' }]

let scores = { A: 0, B: 0 }
let findCalls = 0
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex')
const anchorUri = (id) => 'viking' + '://resources/wechat-plus-route/' + sha1(id).slice(0, 12) + '.md'
rbridge.fetchImpl = async (url, init) => {
  const u = String(url)
  if (u.endsWith('/api/v1/content/write') || u.endsWith('/api/v1/content/reindex')) return { ok: true, json: async () => ({ status: 'ok' }) }
  if (u.endsWith('/api/v1/search/find')) {
    findCalls++
    const body = JSON.parse(init?.body ?? '{}')
    const score = body.target_uri === anchorUri('D:/fake/A') ? scores.A : body.target_uri === anchorUri('D:/fake/B') ? scores.B : 0
    return { ok: true, json: async () => ({ status: 'ok', result: { resources: [{ score }] } }) }
  }
  return { ok: false, status: 404 }
}
const resetRoute = (a, bTo) => {
  scores = { A: a, B: bTo }
  findCalls = 0
  sent.length = 0
  rbridge.routeSilentUntil = 0
}

await check('路由边界：top1 = enter（恰好达标）→ 自动切入（>= 语义）', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.62, 0.2)
  await rbridge.routeMessage(rchat, '项目A的活')
  assert.equal(rbridge.getBinding(rchat).projectId, 'D:/fake/A', 'score===enter 应切入')
})
await check('路由边界：top1 = enter−ε → 留日常', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.6199, 0.2)
  await rbridge.routeMessage(rchat, '项目A的活')
  assert.equal(rbridge.getBinding(rchat).projectId, '__daily__')
  assert.equal(rbridge.menus.size, 0, '低于阈值不应发菜单')
})
await check('路由边界：top1−top2 恰好 = margin → 歧义菜单（<= 语义）', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.9, 0.82) // 差 0.08 === margin
  await rbridge.routeMessage(rchat, '修一下')
  assert.equal(rbridge.activeMenu(rchat)?.kind, 'route-choice', '差恰好等于 margin 应判歧义')
  rbridge.menus.delete(rchat.key)
})
await check('路由边界：top1−top2 = margin+ε → 高置信直切', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.9, 0.8199) // 差略大于 margin
  await rbridge.routeMessage(rchat, '修一下')
  assert.equal(rbridge.getBinding(rchat).projectId, 'D:/fake/A')
  assert.equal(rbridge.menus.size, 0)
})
await check('迟滞边界：项目中 other = enter+0.05（恰好）→ 不建议（> 严格语义）', async () => {
  await rbridge.switchProject(rchat, 'D:/fake/A', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.3, 0.67) // enter+迟滞 = 0.67，恰好等于 → 不触发
  await rbridge.routeMessage(rchat, '来跑项目B的测试')
  assert.equal(rbridge.menus.size, 0, 'other.score 必须严格大于 enter+0.05 才建议')
})
await check('迟滞边界：other = enter+0.06 → 建议菜单；但当前项目分更高时不建议', async () => {
  await rbridge.switchProject(rchat, 'D:/fake/A', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.3, 0.68)
  await rbridge.routeMessage(rchat, '来跑项目B的测试')
  assert.equal(rbridge.activeMenu(rchat)?.kind, 'route-suggest')
  rbridge.menus.delete(rchat.key)
  // other 高于迟滞但不高于 current+margin → 不建议
  resetRoute(0.68, 0.7)
  await rbridge.routeMessage(rchat, '来跑项目B的测试')
  assert.equal(rbridge.menus.size, 0, 'other 须高于 current+margin 才建议')
})
await check('迟滞边界：无工作意图不建议（闲聊不切出）', async () => {
  await rbridge.switchProject(rchat, 'D:/fake/A', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.1, 0.95)
  await rbridge.routeMessage(rchat, '哈哈哈今天好累')
  assert.equal(rbridge.menus.size, 0, '无工作意图不发建议')
})
await check('静默窗口：routeSilentUntil 未过期 → 不查相似度不动作', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  resetRoute(0.95, 0.1)
  rbridge.routeSilentUntil = Date.now() + 30 * 1000 // 手动切换后 60s 内
  await rbridge.routeMessage(rchat, '项目A的活')
  assert.equal(findCalls, 0, '静默窗口内不应调用相似度服务')
  assert.equal(rbridge.getBinding(rchat).projectId, '__daily__')
  assert.equal(sent.length, 0)
  rbridge.routeSilentUntil = 0
})
await check('stayUntil 过期后恢复路由（边界：刚过期）', async () => {
  await rbridge.switchProject(rchat, '__daily__', { silent: true })
  rbridge.routeSilentUntil = 0
  const b = rbridge.getBinding(rchat)
  b.stayUntil = Date.now() - 1 // 已过期
  resetRoute(0.95, 0.1)
  await rbridge.routeMessage(rchat, '项目A的活')
  assert.equal(rbridge.getBinding(rchat).projectId, 'D:/fake/A', '过期 stay 不应再静默')
  b.stayUntil = null
})

rmSync(stateDir, { recursive: true, force: true })
rmSync(smokeHome, { recursive: true, force: true })

console.log(`\n========== 会话管理单元测试结果：${passed} 通过，${failures.length} 失败 ==========`)
if (failures.length > 0) {
  for (const f of failures) console.log(`失败：${f.name}\n  ${f.error?.stack ?? f.error}`)
  process.exit(1)
}
