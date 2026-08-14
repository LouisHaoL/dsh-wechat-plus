// TTS 合成子进程：完全隔离第三方库 msedge-tts。
// 该库内部存在无 catch 的游离 Promise（网络异常时未处理拒绝），
// 在 DSH 主进程内运行会触发 DSH 的 fail-loud 退出机制（整个应用崩溃）。
// 因此 TTS 一律在本子进程执行，任何异常只影响子进程自身。
// 用法：node tts-worker.mjs <textFile> <outDir> [voice]
import { readFileSync } from 'node:fs'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

const [textFile, outDir] = process.argv.slice(2)
const voice = process.argv[3] || 'zh-CN-YunxiNeural'

try {
  const text = readFileSync(textFile, 'utf8').trim().slice(0, 800)
  if (!text) {
    console.error('empty text')
    process.exit(2)
  }
  const tts = new MsEdgeTTS()
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const { audioFilePath } = await tts.toFile(outDir, text)
  if (!audioFilePath) {
    console.error('no audio file produced')
    process.exit(3)
  }
  console.log(audioFilePath)
  process.exit(0)
} catch (error) {
  console.error(error?.message ?? String(error))
  process.exit(1)
}
