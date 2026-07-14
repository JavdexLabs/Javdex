import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const expected = [
  ['mediapipe/vision_wasm_module_internal.js'],
  ['mediapipe/vision_wasm_module_internal.wasm'],
  ['models/blaze_face_full_range.tflite', '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b'],
  ['models/face_landmarker.task', '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'],
  ['models/hair_segmenter.tflite', '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84']
]
const outputRoot = resolve('out/renderer')
let totalBytes = 0

for (const [relativePath, expectedSha256] of expected) {
  const filePath = resolve(outputRoot, relativePath)
  if (!existsSync(filePath)) throw new Error(`缺少智能构图运行资源：${relativePath}`)
  const contents = readFileSync(filePath)
  totalBytes += statSync(filePath).size
  if (expectedSha256) {
    const actualSha256 = createHash('sha256').update(contents).digest('hex')
    if (actualSha256 !== expectedSha256) {
      throw new Error(`智能构图模型校验失败：${relativePath}`)
    }
  }
}

const runtimeFiles = readdirSync(resolve(outputRoot, 'mediapipe'))
if (runtimeFiles.length !== 2 || runtimeFiles.some((name) => !expected.some(([path]) => path === `mediapipe/${name}`))) {
  throw new Error(`MediaPipe 运行时包含非预期文件：${runtimeFiles.join(', ')}`)
}

const maxBytes = 17 * 1024 * 1024
if (totalBytes > maxBytes) {
  throw new Error(`智能构图运行资源超过 17 MiB：${(totalBytes / 1024 / 1024).toFixed(2)} MiB`)
}

console.log(`智能构图运行资源：${(totalBytes / 1024 / 1024).toFixed(2)} MiB（${expected.length} 个文件）`)
