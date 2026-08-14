// 本地开发保护：npm/pnpm install 会用 npm 发布版替换 @deepseek-ai 目录，
// 导致与运行中的 DSH（rc.5 系列）版本不一致而无法加载。
// 本脚本在每次 install 后把 node_modules/@deepseek-ai 重建为指向 DSH 安装目录的 junction。
// 在 CI/无 DSH 安装的环境（Linux、无目标目录）自动跳过，使用 npm 安装的 peer 依赖。
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const candidates = [
  'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'host') : '',
  process.env.DSH_TEST_HOST ?? ''
].filter(Boolean)

const target = candidates.find((dir) => existsSync(join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')))

if (!target) {
  console.log('[ensure-host-junction] 未找到 DSH 安装（CI/无 DSH 环境），跳过。')
  process.exit(0)
}

const link = join(process.cwd(), 'node_modules', '@deepseek-ai')
const real = join(target, 'node_modules', '@deepseek-ai')

try {
  const { lstatSync, readlinkSync } = await import('node:fs')
  const cur = lstatSync(link)
  if (cur.isSymbolicLink() && readlinkSync(link) === real) {
    console.log('[ensure-host-junction] junction 已正确，跳过。')
    process.exit(0)
  }
} catch { /* 不存在或非链接 → 重建 */ }

if (existsSync(link)) rmSync(link, { recursive: true, force: true })
if (!existsSync(join(process.cwd(), 'node_modules'))) mkdirSync(join(process.cwd(), 'node_modules'))
execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, real], { stdio: 'inherit' })
console.log('[ensure-host-junction] 已重建 @deepseek-ai junction →', real)
