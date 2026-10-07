import { buildMacAiRuntime } from './ai-runtime-build.mjs'
if (process.platform === 'darwin') console.log(`AI runtime ready: ${await buildMacAiRuntime()}`)
else console.log('AI runtime tools use pinned platform downloads; no local compilation needed.')
