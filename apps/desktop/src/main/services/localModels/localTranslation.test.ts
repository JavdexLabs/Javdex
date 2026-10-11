import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localSubtitleTranslationPrompt, localTextTranslationPrompt, localTranslationSettings, localTranslationVersion } from './localTranslation'
import { LOCAL_MODEL_ASSETS } from './runtimeManifest'

test('model policies cannot be mutated through returned settings or silently fall back for an unknown model', () => {
  for (const model of ['qwen3', 'hy-mt2-7b'] as const) {
    const expected = localTranslationSettings(model), settings = localTranslationSettings(model)
    settings.serverArguments.push('--fixture')
    settings.request.temperature = 100
    settings.request.stop?.push('fixture')
    if (settings.request.chat_template_kwargs) settings.request.chat_template_kwargs.enable_thinking = true
    assert.deepEqual(localTranslationSettings(model), expected)
  }
  for (const model of ['unknown', '__proto__'] as never[]) {
    assert.throws(() => localTranslationSettings(model), /未知/)
    assert.throws(() => localTranslationVersion(model, 'weight'), /未知/)
    assert.throws(() => localTextTranslationPrompt(model, 'text'), /未知/)
    assert.throws(() => localSubtitleTranslationPrompt(model, 'text', []), /未知/)
  }
})

test('HY 7B uses its native stop tokens and corrects the pinned GGUF dollar-sign EOS without Qwen thinking controls', () => {
  const settings = localTranslationSettings('hy-mt2-7b')
  assert.deepEqual(settings.serverArguments, ['--jinja', '--override-kv', 'tokenizer.ggml.eos_token_id=int:127960,tokenizer.ggml.eot_token_id=int:127967'])
  assert.deepEqual(settings.request, { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05,
    stop: ['<|eos|>', '<|extra_5|>'] })
  assert.equal('chat_template_kwargs' in settings.request, false)
  assert.throws(() => localTranslationSettings('unknown' as never), /未知/)
})

test('Qwen preserves its original inference policy, prompts and precision cache identities', () => {
  assert.deepEqual(localTranslationSettings('qwen3'), { serverArguments: [], request: {
    temperature: 0.7, top_k: 20, top_p: 0.8, repeat_penalty: 1.05, chat_template_kwargs: { enable_thinking: false }
  } })
  assert.equal(localSubtitleTranslationPrompt('qwen3', 'はい', []),
    '将以下日语文本翻译为简体中文。忠实保留口语含义，只输出译文，不要解释或补充原文没有的信息：\n\nはい')
  assert.match(localTextTranslationPrompt('qwen3', '标题'), /原文已是中文则原样返回/)
  for (const weight of [LOCAL_MODEL_ASSETS.find(item => item.id === 'translation-model')!.sha256, 'another-qwen-weight']) {
    assert.equal(localTranslationVersion('qwen3', weight), weight)
    assert.notEqual(localTranslationVersion('hy-mt2-7b', weight), weight)
  }
  assert.throws(() => localTranslationVersion('unknown' as never, 'weight'), /未知/)
})

test('HY prompts distinguish context from the current cue and preserve identifiers and subtitle structure', () => {
  const cue = '[说话人 1] これはいくら？\n$10です。'
  const prompt = localSubtitleTranslationPrompt('hy-mt2-7b', cue, ['前の会話'])
  assert.match(prompt, /仅供理解上下文，不要翻译这些句子/)
  assert.match(prompt, /说话人标签和原文换行/)
  assert.ok(prompt.endsWith(cue))
  const text = localTextTranslationPrompt('hy-mt2-7b', 'ABC-123: $10')
  assert.match(text, /番号、作品代号、人名标识和原文结构/)
  assert.ok(text.endsWith('ABC-123: $10'))
})
