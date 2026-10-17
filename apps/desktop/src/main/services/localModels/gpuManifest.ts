import type { AiRuntimeAsset, AiRuntimeTarget } from './runtimeManifest'

/** CUDA 12.4 covers the initial Windows NVIDIA target; unsupported GPUs fail the native probe. */
export function gpuRuntimeAssets(target: AiRuntimeTarget, backend: 'cuda' | 'vulkan'): AiRuntimeAsset[] {
  if (target.platform !== 'win32' || target.arch !== 'x64') return []
  const llama = 'https://github.com/ggml-org/llama.cpp/releases/download/b11435/'
  if (backend === 'vulkan') return [{ id: 'translator', label: 'Vulkan 翻译运行库', backend, archive: true,
    filename: 'llama-vulkan.zip', bytes: 33337420, sha256: '631b029f7df84aa22d1b8c9c929ea3cc505a70ad091f90ac0eabdb7ef0d05563',
    url: `${llama}llama-b11435-bin-win-vulkan-x64.zip` },
    { id: 'whisper', label: 'Vulkan 语音识别运行库', backend, archive: true, bundledVersion: 'whisper-b5130-vulkan-v1',
      filename: 'whisper-vulkan', bytes: 0, sha256: '41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde',
      url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/927cfce34f31707e17f2bff35c349632fb9e2c3a' }]
  return [
    { id: 'translator', label: 'CUDA 翻译运行库', backend, archive: true, filename: 'llama-cuda.zip', bytes: 264473456,
      sha256: '18ef0727457adf843fe0e6dc17da296c019c821e56b7bc5fc88db734538fbfb7',
      url: `${llama}llama-b11435-bin-win-cuda-12.4-x64.zip`, expandedBytes: 2 * 1024 ** 3 },
    { id: 'cuda', label: 'CUDA 翻译运行依赖', backend, archive: true, filename: 'cudart.zip', bytes: 391443627,
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
      url: `${llama}cudart-llama-bin-win-cuda-12.4-x64.zip`, expandedBytes: 2 * 1024 ** 3 },
    { id: 'whisper', label: 'CUDA 语音识别运行库', backend, archive: true, filename: 'whisper-cuda.zip', bytes: 674539285,
      sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip', expandedBytes: 3 * 1024 ** 3 }
  ]
}
