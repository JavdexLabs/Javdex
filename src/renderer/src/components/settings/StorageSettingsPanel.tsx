import type { AppSettings } from '@shared/types'
import SettingsSwitchRow from '../SettingsSwitchRow'
import { SettingsCard, SettingsSectionBlock } from './SettingsPrimitives'

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

  return (
    <>
      <SettingsCard className="storage-settings-page">
        <SettingsSectionBlock
          title="媒体资源目录"
          hint="封面、头像、样张与清单封面均保存在此目录；修改后会自动迁移现有文件。"
          actions={
            <button
              type="button"
              className="btn btn-sm"
              disabled={storageBusy}
              onClick={onPickMediaAssetsPath}
            >
              更改路径
            </button>
          }
        >
          <div className="media-path-list">
            <div className="path-row">
              <span className="path-row-text" title={resolvedPath}>
                {resolvedPath}
              </span>
            </div>
            {usingDefault ? (
              <p className="settings-form-hint">当前使用应用数据目录下的默认文件夹。</p>
            ) : (
              <div className="settings-inline-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={storageBusy}
                  onClick={onResetMediaAssetsPath}
                >
                  恢复默认路径
                </button>
              </div>
            )}
          </div>
        </SettingsSectionBlock>
      </SettingsCard>

      <SettingsCard
        title="图片加密存储"
        hint="将封面、头像、样张与清单封面加密为 .enc 文件保存，磁盘路径改为不可辨识的哈希名；关闭时解密并恢复原名。切换开关会全库迁移，期间应用暂时不可用。"
      >
        <div className="settings-toggle-list">
          <SettingsSwitchRow
            title="启用图片加密"
            checked={settings.assetEncryption}
            disabled={storageBusy}
            onChange={onToggleAssetEncryption}
          />
        </div>
        <p className="settings-form-hint">加密密钥由本机安装信息派生，资源目录拷贝到其他电脑无法直接读取。</p>
      </SettingsCard>
    </>
  )
}
