import { fetchUpdateBundleManifest } from '@http/updateBundle'
import { serverUpgradeVersionSchema, signedUpdateSchema, updateManifestSchema, type SignedServerUpdate } from '@shared/serverUpdateTypes'

/** Recovery targets the exact desktop version, including its prerelease suffix. */
export async function discoverUpgrade(platform: string | null, targetVersion: string,
  readRelease: (url: string) => Promise<unknown>, readManifest: (url: URL) => Promise<unknown> = fetchUpdateBundleManifest): Promise<SignedServerUpdate> {
  if (!platform) throw new Error('无法确认服务端架构')
  serverUpgradeVersionSchema.parse(targetVersion)
  const release = await readRelease(`https://api.github.com/repos/JavdexLabs/Javdex/releases/tags/v${encodeURIComponent(targetVersion)}`) as {
    tag_name?: string; draft?: boolean; assets?: Array<{ name: string; browser_download_url: string }>
  }
  if (release.draft || release.tag_name !== `v${targetVersion}`) throw new Error('未找到与此客户端版本一致的官方发布，请使用匹配版本的离线包或检查基础镜像')
  const suffix = `-${platform.replace('/', '-')}.javdex-update`
  const asset = release.assets?.find(value => value.name === `Javdex-server-${targetVersion}${suffix}`)
  if (!asset) throw new Error('该版本未提供当前架构的升级包，请使用匹配的离线包或按部署说明升级基础镜像')
  const source = new URL(asset.browser_download_url)
  if (source.protocol !== 'https:' || source.hostname !== 'github.com' || source.username || source.password || !source.pathname.startsWith('/JavdexLabs/Javdex/releases/download/')) throw new Error('升级包来源无效')
  const signed = signedUpdateSchema.parse(await readManifest(source))
  if (updateManifestSchema.parse(JSON.parse(signed.payload)).version !== targetVersion) throw new Error('官方升级包与此客户端版本不一致')
  return signed
}
