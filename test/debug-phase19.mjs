// 阶段 19 独立调试：全可见日志，定位"回退测试"消息消失的原因。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { EventEmitter } from 'node:events'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_HOME = join(HERE, '.home')
const PROFILE_DIR = join(TEST_HOME, 'profiles', 'bridge-test')
const WORK_DIR = join(HERE, '.work')
const HOST = process.env.DSH_TEST_HOST ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host'
const REAL_HOME = process.env.DSH_TEST_REAL_HOME ?? 'C:/Users/Administrator/.dsh'

process.env.DSH_HOME = TEST_HOME
mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(WORK_DIR, { recursive: true })
{
  const stateDir = join(TEST_HOME, 'wechat-bridge')
  for (const f of ['chats.json', 'jobs-state.json', 'override.json', 'bridge.lock', 'state.json']) {
    const p = join(stateDir, f)
    if (existsSync(p)) unlinkSync(p)
  }
}
writeFileSync(join(PROFILE_DIR, 'cordis.yml'), '[]\n')
copyFileSync(join(REAL_HOME, '.credentials.yaml'), join(TEST_HOME, '.credentials.yaml'))
copyFileSync(join(REAL_HOME, 'settings.yaml'), join(TEST_HOME, 'settings.yaml'))

const { boot, loadOverlayPatches, healProfilesModuleFallback } = await import(pathToFileURL(HOST + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'))
const { WeChatBridge } = await import(new URL('../lib/index.js', import.meta.url))
healProfilesModuleFallback(HOST + '/package.json', TEST_HOME)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info: (...p) => console.log('  [O]', ...p), warn: (...p) => console.log('  [O]', ...p), error: (...p) => console.log('  [O]', ...p) }

class FakeClient extends EventEmitter {
  constructor() { super(); this.sent = []; this._r = null }
  async start() { return new Promise((res) => { this._r = res }) }
  stop() { this._r?.(); this._r = null }
  async sendText(to, text, ct) { this.sent.push({ to, text, ct }); console.log('  [SEND]', JSON.stringify(text).slice(0, 80)); return 'ok' }
  async downloadMedia() { return { data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), kind: 'image' } }
  async login(opts = {}) { opts.onStatus?.('confirmed'); return { connected: true, botToken: 't', accountId: 'a@im.bot', baseUrl: 'https://x.invalid', userId: 'u-fake', message: 'ok' } }
}

let mid = 0
const makeMsgFrom = (userId, text) => ({ message_type: 1, message_id: ++mid, from_user_id: userId, create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }], context_token: 'ctx-1' })

console.log('boot...')
const patches = loadOverlayPatches('dsh', HOST + '/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')
const ctx = await boot('dsh', join(PROFILE_DIR, 'cordis.yml'), patches)
console.log('booted')

const config = { enabled: true, token: '', accountId: '', baseUrl: 'https://example.invalid', allowFrom: ['*'], admins: [], workDir: WORK_DIR, blockLinks: true, streaming: true, idleTimeoutMins: 0, maxReplyChars: 1500, loginCooldownSecs: 1, singleton: false }

const ovFile = join(TEST_HOME, 'wechat-bridge', 'override.json')
writeFileSync(ovFile, JSON.stringify({ allowFrom: ['u-admin'], admins: ['u-admin'] }, null, 2))
const bridgeO = new WeChatBridge(ctx, config, log, FakeClient)
await bridgeO.start()
await sleep(2000)
console.log('phase =', bridgeO.phase, 'disposed =', bridgeO.disposed, 'override =', JSON.stringify(bridgeO.override), 'effectiveAllowFrom =', JSON.stringify(bridgeO.effectiveAllowFrom()))

bridgeO.client.emit('message', makeMsgFrom('u-admin', '管理员消息测试'))
await sleep(3000)

console.log('--- 热加载：加入 u-other ---')
writeFileSync(ovFile, JSON.stringify({ allowFrom: ['u-admin', 'u-other'], admins: ['u-admin'] }, null, 2))
await sleep(8000)
console.log('override 现在 =', JSON.stringify(bridgeO.override), 'effectiveAllowFrom =', JSON.stringify(bridgeO.effectiveAllowFrom()))

bridgeO.client.emit('message', makeMsgFrom('u-other', '/new'))
await sleep(3000)

console.log('--- 删除 override.json ---')
unlinkSync(ovFile)
await sleep(8000)
console.log('override 现在 =', JSON.stringify(bridgeO.override), 'effectiveAllowFrom =', JSON.stringify(bridgeO.effectiveAllowFrom()), 'disposed =', bridgeO.disposed, 'phase =', bridgeO.phase)

console.log('--- 发回退测试消息 ---')
bridgeO.client.emit('message', makeMsgFrom('u-other', '回退测试'))
await sleep(60000)
console.log('sent 数 =', bridgeO.client.sent.length)

await bridgeO.dispose()
await ctx.fiber.dispose()
process.exit(0)
