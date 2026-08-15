// 纯单元测试：不依赖 DSH 服务树，可在 GitHub Actions CI 上运行。
// 覆盖：流式消毒器、cron 解析器（其余全链路见 test/integration.mjs）。
import assert from 'node:assert/strict'
import { createStreamSanitizer, parseCron, nextCronAfter, safeSendCut } from '../lib/index.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`)
  }
}

console.log('== 单元测试 ==')

check('消毒：剥离 invoke/tool_calls 工具 XML（跨片）', () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('我先看看目录。 <tool_calls>')
  out += s.feed('<invoke name="exec"> <param')
  out += s.feed('eter name="cmd">dir</parameter> </invoke>')
  out += s.feed('</tool_calls> 目录里有这些文件。')
  out += s.flush()
  assert.equal(out.includes('<'), false, `标记泄漏：${JSON.stringify(out)}`)
  assert.ok(out.includes('我先看看目录。'), '丢失开头')
  assert.ok(out.includes('目录里有这些文件。'), '丢失结尾')
})

check('消毒：剥离思考块与 bash 工具标签', () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('我来查一下。 <zhimayc-think>内部思考</zhimayc-think>')
  out += s.feed('<bash>curl example.com</bash> 查完了，结果是晴天。')
  out += s.flush()
  assert.ok(!out.includes('内部思考'), '思考泄漏')
  assert.ok(!out.includes('curl'), '工具内容泄漏')
  assert.ok(out.includes('查完了，结果是晴天。'), '丢失正文')
})

check('消毒：普通尖括号文本不误伤', () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('比较 1 <')
  out += s.flush()
  out += s.feed('2 是对的')
  out += s.flush()
  assert.ok(out.includes('1 <2'), `误删：${JSON.stringify(out)}`)
})

check('消毒：剥离审批请求包装（gongfeng-tool 实测格式）', () => {
  const s = createStreamSanitizer()
  let out = ''
  out += s.feed('好的，我现在查天气：<gongfeng-tool permission="ask"')
  out += s.feed(' requires-approval="true"><type>approval-request</type><tool>RunCommand</tool>')
  out += s.feed('<command>curl open-meteo</command></gongfeng-tool> 查完了，上海今天 22 度。')
  out += s.flush()
  assert.ok(!out.includes('gongfeng'), '审批包装泄漏')
  assert.ok(!out.includes('curl'), '命令内容泄漏')
  assert.ok(out.includes('查完了，上海今天 22 度。'), '丢失正文')
  assert.ok(out.includes('好的，我现在查天气：'), '丢失前言')
})

check('cron：解析 5 段表达式', () => {
  const cron = parseCron('0 7 * * 1-5')
  assert.ok(cron, '解析失败')
  assert.ok(cron.minute.has(0) && cron.hour.has(7), '分/时不匹配')
  assert.ok(cron.dow.has(1) && cron.dow.has(5) && !cron.dow.has(6), '星期不匹配')
  assert.equal(parseCron('invalid'), null, '无效表达式应返回 null')
  assert.equal(parseCron('0 7 * *'), null, '4 段应返回 null')
})

check('cron：*/n 步进与列表', () => {
  const cron = parseCron('*/15 8,20 * * *')
  assert.ok(cron.minute.has(0) && cron.minute.has(15) && cron.minute.has(45), '步进不匹配')
  assert.ok(cron.hour.has(8) && cron.hour.has(20) && !cron.hour.has(12), '列表不匹配')
})

check('cron：nextCronAfter 计算下一触发时刻', () => {
  const cron = parseCron('0 7 * * *')
  const next = new Date(nextCronAfter(cron, new Date('2026-08-15T06:59:00').getTime()))
  assert.equal(next.getHours(), 7)
  assert.equal(next.getMinutes(), 0)
  const everyMin = parseCron('* * * * *')
  const nextMin = new Date(nextCronAfter(everyMin, Date.now()))
  assert.ok(nextMin.getTime() > Date.now(), '下一时刻应在未来')
})

check('safeSendCut：无断点返回 -1，句读后断开不切词', () => {
  assert.equal(safeSendCut('今天天气很', 160), -1, '纯文本无断点应返回 -1')
  assert.equal(safeSendCut('今天天气很好，明天', 160), 7, '应在逗号后断开')
  assert.equal(safeSendCut('好的。', 160), 3, '应在句号后断开')
})

check('safeSendCut：URL 在 / ? = 处断开（避免切碎链接）', () => {
  const url = 'https://wttr.in/Shanghai?format=j1'
  const cut = safeSendCut(url, 160)
  assert.ok(cut > 0 && cut < url.length, 'URL 应能找到断点')
  assert.equal(url[cut - 1], '=', '最后一个断点应是 =')
})

check('safeSendCut：只搜索末尾 window，前缀断点不计', () => {
  const text = '第一段。第二段' // 「第一段。」是 4 字符前的前缀断点
  assert.equal(safeSendCut(text, 3), -1, '窗口外的断点不应使用')
  assert.equal(safeSendCut(text, 4), 4, '窗口内的断点应使用')
})

console.log(`\n========== 单元测试结果：${passed} 通过，${failures.length} 失败 ==========`)
if (failures.length > 0) {
  for (const f of failures) console.log(`失败：${f.name}\n  ${f.error?.stack ?? f.error}`)
  process.exit(1)
}
