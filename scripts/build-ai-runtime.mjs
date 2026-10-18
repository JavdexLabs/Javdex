import { buildMacAiRuntime } from './ai-runtime-build.mjs'
if (process.argv.includes('--vulkan')) throw new Error('Windows Whisper Vulkan is now downloaded through model preparation; native builds live in JavdexLabs/javdex-runtime.')
if (process.platform === 'darwin') console.log(`AI runtime ready: ${await buildMacAiRuntime()}`)
else console.log('AI runtime tools use pinned platform downloads; no local compilation needed.')
