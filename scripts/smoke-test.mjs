// 冒烟测试：验证 iLink 官方 Bot API 可达性、wechat-ilink-client 基础调用、
// 以及本地二维码生成（qrcode 依赖）。只获取登录二维码（服务端会自动过期），
// 不轮询、不登录、不发消息。
import { ApiClient } from 'wechat-ilink-client'
import qrcode from 'qrcode'

const api = new ApiClient({ baseUrl: 'https://ilinkai.weixin.qq.com' })

console.log('[1] 获取登录二维码…')
const qr = await api.getQRCode('3')
console.log('    qrcode id 前缀:', String(qr.qrcode ?? '').slice(0, 16))
const content = String(qr.qrcode_img_content ?? '')
console.log('    二维码内容类型:', content.startsWith('http') ? 'URL' : content.startsWith('data:') ? 'dataURL' : content.length > 100 ? '疑似 base64 图片' : '其他')
console.log('    内容前 60 字符:', content.slice(0, 60))
if (!qr.qrcode || !qr.qrcode_img_content) {
  console.error('FAIL: 二维码响应缺少字段')
  process.exit(1)
}

console.log('[2] 本地生成二维码图片…')
let imgSrc = content
if (/^https?:\/\//i.test(content)) {
  imgSrc = await qrcode.toDataURL(content, { margin: 1, width: 320 })
}
if (!imgSrc.startsWith('data:image/png;base64,')) {
  console.error('FAIL: 二维码图片生成结果异常')
  process.exit(1)
}
console.log('    生成成功，dataURL 长度:', imgSrc.length)
console.log('[OK] iLink API 可达、二维码本地生成正常。测试结束（未登录、未产生任何会话）。')
