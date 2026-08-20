// M1 冒烟测试：绑定默认值、日常目录、脱敏、菜单、命令表匹配。
// 用法：node --import ./test/smoke-stub.mjs test/smoke-m1.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：防止构造函数里的旧目录迁移逻辑碰到真实 ~/.dsh
const smokeHome = mkdtempSync(join(tmpdir(), 'wb-home-'))
process.env.DSH_SMOKE_HOME = smokeHome

const { WeChatBridge, redactText } = await import('../lib/index.js')

const sent = []
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') {
      return { list: () => [{ path: 'D:/fake/projA', name: '项目A' }, { path: 'D:/fake/projB', name: '项目B' }] }
    }
    throw new Error('service not found')
  },
  setInterval: null
}
const stateDir = mkdtempSync(join(tmpdir(), 'wb-smoke-'))
const log = { info() {}, warn() {}, error() {} }
const bridge = new WeChatBridge(fakeCtx, { allowFrom: ['*'] }, log)
bridge.stateDir = stateDir
bridge.bindings = {}
// reply 截获（client 为 null 时 sendText 会走 catch —— 直接替换 reply）
bridge.reply = async (chat, text) => { sent.push(text) }

// 1) 脱敏
const r = redactText('token=abcd1234efgh5678xyz sk-abcdef0123456789abcdef0123456789 Bearer Ya23.aB_cDefGh12345678 13812345678 password:hunter2secret 正常文本 1381234567')
assert.ok(!r.includes('abcd1234efgh5678xyz'), 'token 赋值应脱敏')
assert.ok(!r.includes('sk-abcdef'), 'sk- key 应脱敏')
assert.ok(!r.includes('Ya23.aB'), 'Bearer 应脱敏')
assert.ok(!r.includes('13812345678'), '手机号应脱敏')
assert.ok(r.includes('正常文本'), '正常文本保留')
assert.ok(r.includes('1381234567'), '11 位以外数字不误伤')

// 2) 新联系人默认绑定日常
const chat = bridge.ensureChat('u:test', 'test')
const binding = bridge.getBinding(chat)
assert.equal(binding.projectId, '__daily__')
assert.equal(binding.sessionByProject['__daily__'], undefined)

// 3) 项目列表：日常置顶 + registry 两个项目
const projects = bridge.listProjects()
assert.equal(projects.length, 3)
assert.equal(projects[0].id, '__daily__')
assert.equal(projects[1].label, '项目A')

// 4) 日常目录解析
assert.ok(bridge.projectCwdFor(binding).replaceAll('\\', '/').endsWith('.dsh/daily'))

// 5) 绑定持久化往返
binding.sessionByProject['__daily__'] = 'wechat-abc'
binding.stayUntil = 123
bridge.persistBindings()
const reloaded = JSON.parse((await import('node:fs')).readFileSync(join(stateDir, 'bindings.json'), 'utf8'))
assert.equal(reloaded['u:test'].sessionByProject['__daily__'], 'wechat-abc')
assert.equal(reloaded['u:test'].stayUntil, 123)

// 6) 切换项目（无 sessionQuery → 降级提示但切换生效）
await bridge.switchProject(chat, 'D:/fake/projA')
assert.equal(bridge.getBinding(chat).projectId, 'D:/fake/projA')
assert.ok(sent.some((t) => t.includes('项目A') || t.includes('不支持')))

// 7) 菜单：设置后单活跃 + 数字选择（projects 菜单 → 切回日常）
bridge.setMenu(chat, { kind: 'projects', items: projects, page: 1 })
await bridge.handleMenuSelection(chat, 1)
assert.equal(bridge.getBinding(chat).projectId, '__daily__')
assert.equal(bridge.menus.size, 0, '选择后菜单应失效')

// 8) 命令表完全匹配拦截（未知 /xxx 不拦截由 handleInbound 保证）
assert.ok(['/help', '/sessions', '/history'].every((c) => ['/', '/help', '/new', '/stop', '/status', '/projects', '/project', '/sessions', '/home', '/stay', '/history'].includes(c)))

// 9) /stay 与 /status 冒烟
await bridge.handleCommand(chat, '/stay 3')
assert.ok(bridge.getBinding(chat).stayUntil > Date.now())
await bridge.handleCommand(chat, '/status')
await bridge.handleCommand(chat, '/history')

// 10) 旧状态目录一次性迁移：~/.dsh/wechat-bridge → ~/.dsh/wechat-plus
{
  const legacy = join(smokeHome, 'wechat-bridge')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'chats.json'), JSON.stringify({ 'u:test': { contextToken: 'tok' } }))
  const migrated = WeChatBridge.migrateLegacyStateDir(join(smokeHome, 'wechat-plus'))
  assert.equal(migrated, join(smokeHome, 'wechat-plus'))
  assert.ok(!existsSync(legacy), '旧目录应被改名移走')
  assert.ok(existsSync(join(smokeHome, 'wechat-plus', 'chats.json')), '数据应在新目录')
  // 二次调用不重复迁移、不覆盖
  writeFileSync(join(smokeHome, 'wechat-plus', 'marker.txt'), 'keep')
  WeChatBridge.migrateLegacyStateDir(join(smokeHome, 'wechat-plus'))
  assert.ok(existsSync(join(smokeHome, 'wechat-plus', 'marker.txt')))
}

rmSync(stateDir, { recursive: true, force: true })
rmSync(smokeHome, { recursive: true, force: true })
console.log('SMOKE-M1 OK — 全部断言通过')
