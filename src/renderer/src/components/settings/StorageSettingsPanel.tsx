import type { AppSettings } from '@shared/types'
import { FolderOpen, HardDrive, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react'
import { UI_ICON_SM } from '../iconDefaults'
import {
  SettingsCard,
  SettingsHeaderSwitch,
  SettingsStatusPill
} from './SettingsPrimitives'

export default function StorageSettingsPanel({
  settings,
  storageBusy,
  onPickMediaAssetsPath,
  onResetMediaAssetsPath,
  onToggleAssetEncryption
}: {
  settings: AppSettings
  storageBusy: boolean
  onPickMediaAssetsPath: () => void
  onResetMediaAssetsPath: () => void
  onToggleAssetEncryption: (checked: boolean) => void
}): JSX.Element {
  const resolvedPath = settings.mediaAssetsResolvedPath ?? settings.mediaAssetsPath
  const usingDefault = !settings.mediaAssetsPath.trim()
  const encryptionEnabled = settings.assetEncryption
  const assetKinds = ['封面', '头像', '样张', '演员写真', '清单封面']

  return (
    <SettingsCard
      className="storage-settings-page"
      title="资源存储"
      hint="管理封面、头像、样张与清单封面的保存位置和磁盘加密方式。"
      actions={
        <div className="storage-status-row" aria-live="polite">
          <SettingsStatusPill status={storageBusy ? 'running' : usingDefault ? 'muted' : 'info'}>
            {storageBusy ? '迁移中' : usingDefault ? '默认目录' : '自定义目录'}
          </SettingsStatusPill>
          <SettingsStatusPill status={encryptionEnabled ? 'success' : 'muted'}>
            {encryptionEnabled ? '加密存储' : '明文存储'}
          </SettingsStatusPill>
        </div>
      }
    >
      <div className="storage-settings-grid" aria-busy={storageBusy}>
        <section className="storage-panel storage-panel--path" aria-label="媒体资源目录">
          <div className="storage-panel-head">
            <span className="storage-panel-icon" aria-hidden="true">
              <HardDrive {...UI_ICON_SM} />
            </span>
            <div className="storage-panel-copy">
              <h4>媒体资源目录</h4>
              <p>修改目录会自动迁移现有图片资源。</p>
            </div>
          </div>

          <div className="storage-path-box">
            <span className="storage-path-label">{usingDefault ? '默认路径' : '当前路径'}</span>
            <div className="storage-path-row">
              <FolderOpen {...UI_ICON_SM} aria-hidden />
              <span className="storage-path-text" title={resolvedPath}>
                {resolvedPath}
              </span>
            </div>
          </div>

          <div className="storage-action-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={storageBusy}
              onClick={onPickMediaAssetsPath}
            >
              <FolderOpen {...UI_ICON_SM} aria-hidden />
              更改目录
            </button>
            {!usingDefault ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={storageBusy}
                onClick={onResetMediaAssetsPath}
              >
                <RotateCcw {...UI_ICON_SM} aria-hidden />
                恢复默认
              </button>
            ) : null}
          </div>
        </section>

        <section className="storage-panel storage-panel--crypto" aria-label="图片加密存储">
          <div className="storage-panel-head">
            <span className="storage-panel-icon" aria-hidden="true">
              {encryptionEnabled ? <ShieldCheck {...UI_ICON_SM} /> : <ShieldOff {...UI_ICON_SM} />}
            </span>
            <div className="storage-panel-copy">
              <h4>图片加密</h4>
              <p>
                {encryptionEnabled
                  ? '资源以 .enc 与哈希文件名保存。'
                  : '资源以可直接查看的图片文件保存。'}
              </p>
            </div>
            <SettingsHeaderSwitch
              label="启用图片加密"
              checked={encryptionEnabled}
              disabled={storageBusy}
              onChange={onToggleAssetEncryption}
            />
          </div>

          <div className="storage-crypto-summary">
            <div className="storage-crypto-state">
              <span>{encryptionEnabled ? '已保护' : '未加密'}</span>
              <strong>{encryptionEnabled ? '.enc' : '原始图片'}</strong>
            </div>
            <p>
              开关会触发全库迁移；处理中应用会暂时锁定，完成后自动恢复。
            </p>
          </div>
        </section>
      </div>

      <div className="storage-footnote">
        <span className="storage-footnote-label">覆盖资源</span>
        <div className="storage-kind-list" aria-label="存储覆盖的资源类型">
          {assetKinds.map((item) => (
            <span key={item} className="storage-kind-chip">
              {item}
            </span>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}
