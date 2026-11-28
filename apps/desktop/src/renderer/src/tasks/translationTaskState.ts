import type { TranslationFieldStatus, TranslationModelView } from '@shared/desktop/metadataTranslationTasks'
import type { MetadataTranslationField } from '@shared/metadataTranslation'

export const TRANSLATION_TASKS_KEY = ['metadata-translation-tasks'] as const
export const translationDirectApplyDescription = '开启时，译文自动替换媒体库中所选字段的原文。关闭时，译文保存为草稿，需在「任务中心 → 翻译」手动应用。'
export const translationFieldLabel: Record<MetadataTranslationField, string> = { title: '标题', summary: '简介' }
export const translationModelLocation: Record<TranslationModelView['location'], string> = {
  'local-model': '本地模型', 'local-service': '本地服务', cloud: '云端服务'
}
export const translationStatusLabel: Record<TranslationFieldStatus, string> = {
  queued: '排队中', running: '翻译中', review: '待确认', failed: '翻译失败', conflict: '原文冲突',
  blocked: '应用受阻', moved: '已移出来源媒体库', missing: '影片已不存在', applying: '等待写入结果',
  applied: '已应用', skipped: '已跳过', discarded: '已丢弃'
}
