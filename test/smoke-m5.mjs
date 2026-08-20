// M5 冒烟测试：/models /model 模型切换（mock llm 服务）。
// 用法：node --import ./test/smoke-stub.mjs test/smoke-m5.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const smokeHome = mkdtempSync(join(tmpdir(), 'wb-home-'))
process.env.DSH_SMOKE_HOME = smokeHome

const { WeChatBridge } = await import('../lib/index.js')

const sent = []
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => [] }
    if (name === 'llm') {
      return {
        listConfigurableProviders: () => ['deepseek', 'openai'],
        listModels: async (provider) => {
          if (provider === 'deepseek') return [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]
          if (provider === 'openai') return [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]
          throw new Error('unknown provider')
        }
      }
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
    }
    throw new Error('no service')
  }
}
const log = { info() {}, warn() {}, error() {} }
const bridge = new WeChatBridge(fakeCtx, { allowFrom: ['*'] }, log)
bridge.reply = async (chat, text) => { sent.push(text) }
const chat = bridge.ensureChat('u:t5', 't5')

// 1) /models：分组展示 + 当前模型打 ★ + 菜单落地
sent.length = 0
await bridge.handleCommand(chat, '/models')
const listText = sent.join('\n')
assert.ok(listText.includes('〔deepseek〕') && listText.includes('〔openai〕'), '应按 provider 分组')
assert.ok(listText.includes('deepseek-chat ★当前'), '默认选择应打 ★')
assert.ok(listText.includes('deepseek-reasoner'))
const menu = bridge.activeMenu(chat)
assert.equal(menu?.kind, 'model-choice')
assert.equal(menu.items.length, 4, '四个模型全部入菜单')
assert.deepEqual(menu.items[1], { provider: 'deepseek', model: 'deepseek-reasoner' })

// 2) 菜单数字选择 → 切换回执 + 绑定持久化
sent.length = 0
await bridge.handleMenuSelection(chat, 2)
assert.ok(sent.some((t) => t.includes('模型已切换：deepseek-chat → deepseek-reasoner')), sent.join('|'))
assert.deepEqual(bridge.getBinding(chat).model, { provider: 'deepseek', model: 'deepseek-reasoner' })
const disk = JSON.parse(readFileSync(join(bridge.stateDir, 'bindings.json'), 'utf8'))
assert.equal(disk['u:t5'].model.model, 'deepseek-reasoner', '切换应落盘')

// 3) /model 无参 = 显示当前模型
sent.length = 0
await bridge.handleCommand(chat, '/model')
assert.ok(sent.some((t) => t.includes('deepseek-reasoner')), '应显示当前模型')

// 4) 名称精确匹配（跨 provider）
sent.length = 0
await bridge.handleCommand(chat, '/model gpt-4o-mini')
assert.ok(sent.some((t) => t.includes('→ gpt-4o-mini')), '精确 id 应可切换')
assert.equal(bridge.getBinding(chat).model.provider, 'openai')

// 5) 子串唯一匹配
sent.length = 0
await bridge.handleCommand(chat, '/model reasoner')
assert.ok(sent.some((t) => t.includes('→ deepseek-reasoner')), '唯一子串应可切换')

// 6) 子串多匹配 → 报错并列出候选（精确 id 优先，故用非精确子串触发多匹配）
sent.length = 0
await bridge.handleCommand(chat, '/model gpt')
const multi = sent.join('\n')
assert.ok(multi.includes('匹配到 2 个'), '多匹配应报错')
assert.ok(multi.includes('openai/gpt-4o') && multi.includes('openai/gpt-4o-mini'), '应列出候选')

// 6b) 精确 id 优先于子串（同名单即便也是别的 id 子串也直接切）
sent.length = 0
await bridge.handleCommand(chat, '/model gpt-4o')
assert.ok(sent.some((t) => t.includes('→ gpt-4o\n') || t.includes('→ gpt-4o') ), '精确 id 应直接切换')

// 7) 无匹配
sent.length = 0
await bridge.handleCommand(chat, '/model 不存在的模型')
assert.ok(sent.some((t) => t.includes('没有匹配')), '无匹配应提示')

// 8) 数字但无活跃菜单 → 提示先 /models
bridge.menus.delete(chat.key)
sent.length = 0
await bridge.handleCommand(chat, '/model 1')
assert.ok(sent.some((t) => t.includes('/models')), '无菜单时数字应提示先看列表')

// 9) modelSelectionFor：覆盖优先于全局默认；无覆盖时回落默认
assert.equal(bridge.modelSelectionFor(chat).model, 'gpt-4o')
bridge.getBinding(chat).model = null
assert.equal(bridge.modelSelectionFor(chat).model, 'deepseek-chat', '无覆盖回落全局默认')

// 10) llm 服务不可用 → 降级提示
const noLlmBridge = new WeChatBridge({ get: () => { throw new Error('no llm') } }, { allowFrom: ['*'] }, log)
noLlmBridge.reply = async (_c, text) => { sent.push(text) }
sent.length = 0
await noLlmBridge.handleCommand(noLlmBridge.ensureChat('u:x', 'x'), '/models')
assert.ok(sent.some((t) => t.includes('不支持模型查询')), 'llm 缺失应降级提示')

// 11) 某 provider 失败 → 跳过该组不挂
const partial = {
  get(name) {
    if (name === 'llm') {
      return {
        listConfigurableProviders: () => ['deepseek', 'broken'],
        listModels: async (p) => p === 'deepseek' ? [{ id: 'deepseek-chat' }] : Promise.reject(new Error('无凭据'))
      }
    }
    throw new Error('no')
  }
}
const pBridge = new WeChatBridge(partial, { allowFrom: ['*'] }, log)
const warned = []
pBridge.log = { info() {}, warn: (m) => warned.push(m), error() {} }
pBridge.reply = async () => {}
const models = await pBridge.listAllModels()
assert.equal(models.length, 1, '失败组应被跳过')
assert.ok(warned.some((w) => w.includes('broken')), '应记日志')

rmSync(smokeHome, { recursive: true, force: true })
console.log('SMOKE-M5 OK — /models /model 全分支断言通过')
