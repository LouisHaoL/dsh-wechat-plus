// 最小复现：直接调用 agents.create，打印 setup 返回值类型，定位 ?.commit 崩溃原因。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_HOME = join(HERE, '.home')
const PROFILE_DIR = join(TEST_HOME, 'profiles', 'bridge-test')
const HOST = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host'
const REAL_HOME = 'C:/Users/Administrator/.dsh'

process.env.DSH_HOME = TEST_HOME
mkdirSync(PROFILE_DIR, { recursive: true })
writeFileSync(join(PROFILE_DIR, 'cordis.yml'), '[]\n')
copyFileSync(join(REAL_HOME, '.credentials.yaml'), join(TEST_HOME, '.credentials.yaml'))
copyFileSync(join(REAL_HOME, 'settings.yaml'), join(TEST_HOME, 'settings.yaml'))

const { boot, loadOverlayPatches, healProfilesModuleFallback } = await import(pathToFileURL(HOST + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'))
const { installModelSelection } = await import(pathToFileURL(HOST + '/node_modules/@deepseek-ai/dsh-agent/lib/index.js'))
const { SessionId } = await import(pathToFileURL(HOST + '/node_modules/@deepseek-ai/dsh-session/lib/index.js'))

healProfilesModuleFallback(HOST + '/package.json', TEST_HOME)
const patches = loadOverlayPatches('dsh', HOST + '/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')
const ctx = await boot('dsh', join(PROFILE_DIR, 'cordis.yml'), patches)
console.log('树已启动')

const agents = ctx.get('agents')
const defaultModel = ctx.get('agentDefaultModel')
const selection = defaultModel.currentSelection()
console.log('selection =', JSON.stringify(selection))

const options = {
  sessionId: SessionId(`wechat-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model }
}
if (selection?.provider && selection?.model) {
  options.setup = (agentCtx) => {
    const r = installModelSelection(agentCtx, { current: selection, assembled: undefined })
    console.log('setup 返回值类型:', typeof r)
    console.log('setup 返回值:', r)
    console.log('r.commit 类型:', typeof r?.commit)
    return r
  }
}

try {
  const { agent } = await agents.create(options)
  console.log('create 成功，agent id =', String(agent.id))
} catch (error) {
  console.error('create 失败:', error?.stack ?? error)
  process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  process.exit()
}
