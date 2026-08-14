// 把 @deepseek-ai/* peer 依赖以 junction 方式链接到 DSH 主机安装目录的 node_modules。
// 为什么需要：插件目录在 DSH 应用安装树之外，Node ESM 解析（从 D:\dsh-wechat-bridge
// 向上找 node_modules）够不到主机自带的包；而 npm 注册表上的同包版本与主机不一致
// （如 dsh-llm 注册表 0.0.1-rc.1 vs 主机 0.1.0-rc.5），必须复用主机副本，
// 保证插件运行时与 DSH 主进程用的是同一批模块实例。
// npm install 会清空 node_modules，因此挂在 postinstall 里自动重建。
// 仅 Windows 使用（junction 免管理员权限）；与 test/resolve-hooks.mjs 同一思路。
import { mkdirSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = process.env.DSH_HOST_NODE_MODULES
  ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host/node_modules'
const PEERS = [
  'schemastery',
  'dsh-agent',
  'dsh-home-paths',
  'dsh-llm',
  'dsh-session',
]

const linkDir = join(repoRoot, 'node_modules', '@deepseek-ai')
mkdirSync(linkDir, { recursive: true })

let created = 0, skipped = 0, missing = 0
for (const name of PEERS) {
  const linkPath = join(linkDir, name)
  const target = join(HOST, '@deepseek-ai', name)
  if (!existsSync(target)) {
    console.warn(`[link-host-peers] 目标不存在，跳过：${target}`)
    missing++
    continue
  }
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) { skipped++; continue }
    // 注册表副本（真实目录）→ 删除后换链接
    rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(target, linkPath, 'junction')
  created++
}
console.log(`[link-host-peers] junction 新建 ${created}，已存在 ${skipped}，缺失目标 ${missing}`)
