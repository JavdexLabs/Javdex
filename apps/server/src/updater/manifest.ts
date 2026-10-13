import { createHash, createPublicKey, verify } from 'node:crypto'
import semver from 'semver'
import { signedUpdateSchema, updateManifestSchema, type ServerUpdateManifest } from '@shared/serverUpdateTypes'

export function verifyUpdateManifest(value: unknown, keys: Record<string, string>, now = Date.now()): ServerUpdateManifest {
  const signed = signedUpdateSchema.parse(value)
  const key = keys[signed.keyId]
  if (!key) throw new Error('更新包签名密钥不受信任')
  const publicKey = createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(signed.payload, 'utf8'), publicKey, Buffer.from(signed.signature, 'base64'))) {
    throw new Error('更新包签名无效')
  }
  const manifest = updateManifestSchema.parse(JSON.parse(signed.payload))
  if (Date.parse(manifest.expiresAt) <= now) throw new Error('更新清单已过期，请获取新的官方更新包')
  return manifest
}

export function checkUpdateTarget(manifest: ServerUpdateManifest, current: { version: string; schema: number; platform: string; runtime?: string }): void {
  if (current.version === '0.8.0' && current.schema !== 19) throw new Error('0.8.0 正式库应为 schema 19；旧开发快照不支持自动升级')
  if (semver.valid(current.version) !== current.version || semver.valid(manifest.version) !== manifest.version || !semver.gt(manifest.version, current.version)) throw new Error('只能安装比当前版本更新的版本')
  if (current.platform !== manifest.platform) throw new Error('更新包架构与服务器不一致')
  if (current.runtime && current.runtime !== manifest.runtime) throw new Error('更新包需要新的容器运行环境，请先升级基础镜像')
  if (!manifest.sourceSchemas.includes(current.schema) || manifest.targetSchema < current.schema) throw new Error('当前数据库没有受支持的升级路径')
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}
