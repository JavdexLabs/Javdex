import type { VideoMetadataSource, VideoMetadataSourceDescriptor } from './types'

export class VideoMetadataSourceRegistry {
  private readonly sources = new Map<string, VideoMetadataSource>()
  private readonly legacyPluginIds = new Map<string, string>()

  constructor(sources: Iterable<VideoMetadataSource> = []) {
    for (const source of sources) this.register(source)
  }

  register(source: VideoMetadataSource): void {
    if (this.sources.has(source.descriptor.id)) {
      throw new Error(`影片元数据来源「${source.descriptor.id}」重复注册`)
    }
    this.sources.set(source.descriptor.id, source)
    if (source.descriptor.kind === 'web-scraper') {
      this.legacyPluginIds.set(source.descriptor.name, source.descriptor.id)
    }
  }

  require(sourceId: string): VideoMetadataSource {
    const source = this.sources.get(sourceId)
    if (!source) throw new Error(`影片元数据来源「${sourceId}」不存在`)
    return source
  }

  requireLegacyPlugin(pluginName: string): VideoMetadataSource {
    const sourceId = this.legacyPluginIds.get(pluginName)
    if (!sourceId) throw new Error(`影片刮削插件「${pluginName}」不存在`)
    return this.require(sourceId)
  }

  list(): VideoMetadataSourceDescriptor[] {
    return [...this.sources.values()].map((source) => source.descriptor)
  }
}
