import { buildMacAiRuntime } from './ai-runtime-build.mjs'
import { buildWindowsVulkanRuntime } from './windows-vulkan-runtime.mjs'
if (process.platform === 'darwin') console.log(`AI runtime ready: ${await buildMacAiRuntime()}`)
else if (process.platform === 'win32' && process.argv.includes('--vulkan')) console.log(`Vulkan AI runtime ready: ${await buildWindowsVulkanRuntime()}`)
else console.log('AI runtime tools use pinned platform downloads; no local compilation needed.')
