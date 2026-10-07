import type { LocalTranslationModelId } from '@shared/desktop/localModels'

const HY_TRANSLATION_VERSION = 'hy-mt2-7b-llama-b11435-prompt-v1'
const INDEX_TRANSLATION_VERSION = 'index-translate-9b-llama-b11435-prompt-v1'

interface TranslationSettings {
  serverArguments: string[]
  request: { temperature: number; repeat_penalty: number; top_k?: number; top_p?: number
    chat_template_kwargs?: { enable_thinking: boolean }; stop?: string[] }
}
interface TranslationPolicy {
  settings: TranslationSettings
  version: string | null
  textPrompt(text: string): string
  subtitlePrompt(japanese: string): string
}

/** Each model owns its full policy; adding one must supply every required strategy. */
const policies: Record<LocalTranslationModelId, TranslationPolicy> = {
  qwen3: {
    settings: { serverArguments: [], request: { temperature: 0.7, top_k: 20, top_p: 0.8, repeat_penalty: 1.05,
      chat_template_kwargs: { enable_thinking: false } } },
    // Qwen's prompt/decoder version remains authoritative in subtitleCache.
    version: null,
    textPrompt: text => `将以下文本翻译成简体中文。只输出译文，不要标题、引号或解释；原文已是中文则原样返回。保留番号、作品代号等标识，不补充原文没有的信息：\n\n${text}`,
    subtitlePrompt: japanese => `将以下日语文本翻译为简体中文。忠实保留口语含义，只输出译文，不要解释或补充原文没有的信息：\n\n${japanese}`
  },
  'hy-mt2-7b': {
    settings: {
      // The pinned GGUF marks token 3 ("$") as EOS; restore the native 7B termination IDs.
      serverArguments: ['--jinja', '--override-kv', 'tokenizer.ggml.eos_token_id=int:127960,tokenizer.ggml.eot_token_id=int:127967'],
      // Use the model card's sampling rather than its different generation_config top_p.
      request: { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05, stop: ['<|eos|>', '<|extra_5|>'] }
    },
    version: HY_TRANSLATION_VERSION,
    textPrompt: text => `将以下文本翻译为简体中文，注意只需要输出翻译后的结果，不要额外解释。保留番号、作品代号、人名标识和原文结构；原文已是简体中文则原样返回，不补充原文没有的信息：\n\n${text}`,
    subtitlePrompt: japanese => `将以下日语对白翻译为简体中文，注意只需要输出翻译后的结果，不要额外解释。忠实保留口语含义、说话人标签和原文换行，不补充原文没有的信息：\n\n${japanese}`
  },
  'index-translate-9b': {
    settings: { serverArguments: ['--jinja'], request: { temperature: 0, repeat_penalty: 1,
      chat_template_kwargs: { enable_thinking: false }, stop: ['<|endoftext|>', '<|im_end|>'] } },
    version: INDEX_TRANSLATION_VERSION,
    textPrompt: text => `请将以下文本翻译成简体中文，并且严格遵循所有约束要求。\n\n【源文】\n${text}\n\n【约束要求】\n1. 【硬性要求】保留番号、作品代号、人名标识、原文格式和换行；原文已是简体中文则原样返回，不补充原文没有的信息。\n\n只输出译文，不要有任何额外说明。`,
    subtitlePrompt: japanese => `请将以下日语对白翻译成简体中文，并且严格遵循所有约束要求。\n\n【源文】\n${japanese}\n\n【约束要求】\n1. 【硬性要求】忠实保留口语含义、说话人标签和原文换行；不补充原文没有的信息，不翻译相邻上下文。\n\n只输出译文，不要有任何额外说明。`
  }
}
function policy(model: LocalTranslationModelId): TranslationPolicy {
  if (!Object.hasOwn(policies, model)) throw new Error('未知的本地翻译模型')
  const value = policies[model]
  return value
}

export function localTranslationSettings(model: LocalTranslationModelId): TranslationSettings {
  return structuredClone(policy(model).settings)
}
export function localTranslationVersion(model: LocalTranslationModelId, weightHash: string): string {
  const version = policy(model).version
  return version ? `${version}:${weightHash}` : weightHash
}

export function localTextTranslationPrompt(model: LocalTranslationModelId, text: string): string {
  return policy(model).textPrompt(text)
}

export function localSubtitleTranslationPrompt(model: LocalTranslationModelId, japanese: string, context: string[]): string {
  const surrounding = context.length ? `以下是相邻日语对白，仅供理解上下文，不要翻译这些句子：\n${context.join('\n')}\n\n` : ''
  return surrounding + policy(model).subtitlePrompt(japanese)
}

export function localTranslationOutput(model: LocalTranslationModelId, content: string): string {
  const text = content.trim()
  // The official Index client drops a leading think block as a safety net.
  // Never publish an unfinished block or reinterpret tags inside the actual translation.
  if (model === 'index-translate-9b' && text.startsWith('<think>')) {
    const end = text.indexOf('</think>')
    return end < 0 ? '' : text.slice(end + '</think>'.length).trim()
  }
  return text
}
