import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import type { SimpleChatMessage } from './openaiChatAdapter'
import { nativeTextToJson, requestNativePayload, type NativeTextResponse } from './nativeTextTransport'

interface GooglePayload {
  error?: { message?: string }
  promptFeedback?: { blockReason?: string }
  candidates?: Array<{
    finishReason?: string
    content?: { parts?: Array<{ text?: string; thought?: boolean }> }
  }>
  usageMetadata?: {
    promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number
    cachedContentTokenCount?: number; totalTokenCount?: number
  }
}

/** Non-Agent invocation. Pi owns Agent streaming and function-call handling. */
export async function requestGoogleText(
  messages: SimpleChatMessage[], config: ResolvedLlmModelRequestConfig, json = false
): Promise<NativeTextResponse> {
  if (!config.googleModelsUrl) throw new Error('Google Gemini 端点未配置')
  if (!config.apiKey.trim()) throw new Error(`请先为「${config.providerName}」填写 API Key`)
  const modelId = config.modelId.replace(/^models\//, '')
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const payload = await requestNativePayload<GooglePayload>(
    `${config.googleModelsUrl}/${encodeURIComponent(modelId)}:generateContent`,
    { 'x-goog-api-key': config.apiKey },
    {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages.filter(message => message.role === 'user')
        .map(message => ({ role: 'user', parts: [{ text: message.content }] })),
      generationConfig: {
        maxOutputTokens: config.maxTokens ?? 12000,
        ...(json ? { responseMimeType: 'application/json' } : {})
      }
    }, config
  )
  if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`)
  const candidate = payload.candidates?.[0]
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini 响应未完成：${candidate.finishReason}`)
  }
  const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('').trim() ?? ''
  const input = payload.usageMetadata?.promptTokenCount ?? 0
  const reasoning = payload.usageMetadata?.thoughtsTokenCount ?? 0
  const output = (payload.usageMetadata?.candidatesTokenCount ?? 0) + reasoning
  const cacheRead = payload.usageMetadata?.cachedContentTokenCount ?? 0
  return {
    text,
    usage: payload.usageMetadata ? {
      input, uncachedInput: Math.max(0, input - cacheRead), output, reasoning,
      cacheRead, cacheWrite: 0, totalTokens: payload.usageMetadata.totalTokenCount ?? input + output
    } : undefined
  }
}

export async function requestGoogleJson<T>(messages: SimpleChatMessage[], config: ResolvedLlmModelRequestConfig) {
  return nativeTextToJson<T>(await requestGoogleText(messages, config, true))
}
