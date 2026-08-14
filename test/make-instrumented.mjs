// 深度插桩：检查 __v 的原型链与 commit 属性描述符，判断是否为状态性 getter。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/host/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
const OUT_DIR = join(HERE, '.instrumented')
mkdirSync(OUT_DIR, { recursive: true })
const OUT = join(OUT_DIR, 'dsh-agent-loop.mjs')

const needle = '(await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id))?.commit();'
const replacement = `await (async () => {
  const __v = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
  try {
    console.error('[INSTR2] typeof __v =', typeof __v);
    console.error('[INSTR2] __v?.commit =', typeof __v?.commit, JSON.stringify(__v?.commit));
    console.error('[INSTR2] __v.commit =', typeof __v.commit, JSON.stringify(__v.commit));
    console.error('[INSTR2] ownProps =', JSON.stringify(Object.getOwnPropertyDescriptors(__v)));
    console.error('[INSTR2] proto === Function.prototype:', Object.getPrototypeOf(__v) === Function.prototype);
    console.error('[INSTR2] proto chain =', (() => { const a = []; let p = __v; while (p && a.length < 6) { a.push(typeof p + ':' + Object.getOwnPropertyNames(p).slice(0, 10).join(',')); p = Object.getPrototypeOf(p); } return a.join(' -> '); })());
    console.error('[INSTR2] Function.prototype.commit desc =', JSON.stringify(Object.getOwnPropertyDescriptor(Function.prototype, 'commit') ?? null));
    console.error('[INSTR2] Object.prototype.commit desc =', JSON.stringify(Object.getOwnPropertyDescriptor(Object.prototype, 'commit') ?? null));
    const r = __v?.commit?.();
    console.error('[INSTR2] commit call result =', typeof r);
    return r;
  } catch (error) {
    console.error('[INSTR2] THROW inside probe:', error?.stack ?? error);
    throw error;
  }
})();`

const src = readFileSync(SRC, 'utf8')
if (!src.includes(needle)) {
  console.error('未找到目标语句，插桩失败')
  process.exit(1)
}
const patched = src.replace(needle, replacement)
writeFileSync(OUT, patched)
console.log('已生成深度插桩版：', OUT)
