// 本地冒烟：stub 掉 @deepseek-ai/* peer 依赖后加载 lib/index.js 并验证 M1 核心纯逻辑。
// 用法：node --import ./test/smoke-stub.mjs test/smoke-m1.mjs
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '.smoke-stubs')
mkdirSync(dir, { recursive: true })
const stubs = {
  '@deepseek-ai/schemastery': 'const fn = () => proxy\nconst proxy = new Proxy(fn, { get: () => fn, apply: () => proxy })\nexport default proxy\nexport const object = proxy\n',
  '@deepseek-ai/dsh-agent': 'export const installModelSelection = () => {}\n',
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = (o) => o\n',
  '@deepseek-ai/dsh-session': 'export const SessionId = (x) => x\n',
  '@deepseek-ai/dsh-home-paths': 'import { homedir } from "node:os"\nimport { join } from "node:path"\nexport const resolveDshHome = () => process.env.DSH_SMOKE_HOME ?? join(homedir(), ".dsh")\n'
}
const map = new Map()
for (const [name, code] of Object.entries(stubs)) {
  const file = join(dir, name.replace(/[\/@]/g, '_') + '.mjs')
  writeFileSync(file, code)
  map.set(name, pathToFileURL(file).href)
}
registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (map.has(specifier)) return { url: map.get(specifier), shortCircuit: true }
    return nextResolve(specifier)
  }
})
