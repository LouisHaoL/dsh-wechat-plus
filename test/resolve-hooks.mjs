// 测试专用：把 @deepseek-ai/* 包解析重定向到 DSH 安装目录的 node_modules。
// 仅在测试进程里使用（node --import ./test/resolve-hooks.mjs test/integration.mjs），
// 生产环境由 DSH 应用进程自身的模块加载器负责解析，无需此文件。
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const HOST = process.env.DSH_TEST_HOST ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host'
const hostRequire = createRequire(pathToFileURL(HOST + '/package.json').href)
const cache = new Map()

function entryFor(specifier) {
  if (!cache.has(specifier)) {
    try {
      cache.set(specifier, pathToFileURL(hostRequire.resolve(specifier)).href)
    } catch {
      cache.set(specifier, null)
    }
  }
  return cache.get(specifier)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (typeof specifier === 'string' && specifier.startsWith('@deepseek-ai/')) {
      // 测试插桩：加载本目录生成的插桩版 agent-loop（若存在）
      if (specifier === '@deepseek-ai/dsh-agent-loop') {
        const instrumentedPath = join(dirname(fileURLToPath(import.meta.url)), '.instrumented', 'dsh-agent-loop.mjs')
        if (existsSync(instrumentedPath)) return { url: pathToFileURL(instrumentedPath).href, shortCircuit: true }
      }
      const entry = entryFor(specifier)
      if (entry) return { url: entry, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
