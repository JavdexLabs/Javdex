import type { SettingsSnapshot } from '@shared/settingsTypes'
import { FolderOpen, HardDrive, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react'
import { UI_ICON_SM } from '../iconDefaults'
import {
  SettingsCard,
  SettingsHeaderSwitch,
  SettingsStatusPill
} from './SettingsPrimitives'
import Button from '../Button'
import styles from './StorageSettingsPanel.module.css'
import NfoExportPanel from './NfoExportPanel'

export default function StorageSettingsPanel({
  settings,
  storageBusy,
  onPickMediaAssetsPath,
  onResetMediaAssetsPath,
  onToggleAssetEncryption,
  onExportBlockingChange
}: {
  settings: SettingsSnapshot
  storageBusy: boolean
  onPickMediaAssetsPath: () => void
  onResetMediaAssetsPath: () => void
  onToggleAssetEncryption: (checked: boolean) => void
  onExportBlockingChange: (blocking: boolean) => void
}): JSX.Element {
  const resolvedPath = settings.mediaAssetsResolvedPath ?? settings.mediaAssetsPath
  const usingDefault = !settings.mediaAssetsPath.trim()
  const encryptionEnabled = settings.assetEncryption
  const assetKinds = ['封面', '头像', '样张', '演员写真', '清单封面']

  return (
    <>
    <SettingsCard
      className={styles.root}
      title="资源存储"
      hint="管理封面、头像、样张与清单封面的保存位置和磁盘加密方式。"
      actions={
        <div className={styles.statusRow} aria-live="polite">
          <SettingsStatusPill status={storageBusy ? 'running' : usingDefault ? 'muted' : 'info'}>
            {storageBusy ? '迁移中' : usingDefault ? '默认目录' : '自定义目录'}
          </SettingsStatusPill>
          <SettingsStatusPill status={encryptionEnabled ? 'success' : 'muted'}>
            {encryptionEnabled ? '加密存储' : '明文存储'}
          </SettingsStatusPill>
        </div>
      }
    >
      <div className={styles.grid} aria-busy={storageBusy}>
        <section className={styles.panel} aria-label="媒体资源目录">
          <div className={styles.panelHead}>
            <span className={styles.panelIcon} aria-hidden="true">
              <HardDrive {...UI_ICON_SM} />
            </span>
            <div className={styles.panelCopy}>
              <h4>媒体资源目录</h4>
              <p>修改目录会自动迁移现有图片资源。</p>
            </div>
          </div>

          <div className={styles.pathBox}>
            <span className={styles.pathLabel}>{usingDefault ? '默认路径' : '当前路径'}</span>
            <div className={styles.pathRow}>
              <FolderOpen {...UI_ICON_SM} aria-hidden />
              <span className={styles.pathText} title={resolvedPath}>
                {resolvedPath}
              </span>
            </div>
          </div>

          <div className={styles.actionRow}>
            <Button
              type="button"
              size="sm"
              disabled={storageBusy}
              onClick={onPickMediaAssetsPath}
            >
              <FolderOpen {...UI_ICON_SM} aria-hidden />
              更改目录
            </Button>
            {!usingDefault ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={storageBusy}
                onClick={onResetMediaAssetsPath}
              >
                <RotateCcw {...UI_ICON_SM} aria-hidden />
                恢复默认
              </Button>
            ) : null}
          </div>
        </section>

        <section className={`${styles.panel} ${styles.cryptoPanel}`} aria-label="图片加密存储">
          <div className={styles.panelHead}>
            <span className={styles.panelIcon} aria-hidden="true">
              {encryptionEnabled ? <ShieldCheck {...UI_ICON_SM} /> : <ShieldOff {...UI_ICON_SM} />}
            </span>
            <div className={styles.panelCopy}>
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

          <div className={styles.cryptoSummary}>
            <div className={styles.cryptoState}>
              <span>{encryptionEnabled ? '已保护' : '未加密'}</span>
              <strong>{encryptionEnabled ? '.enc' : '原始图片'}</strong>
            </div>
            <p>
              开关会触发全库迁移；处理中应用会暂时锁定，完成后自动恢复。
            </p>
          </div>
        </section>
      </div>

      <div className={styles.footnote}>
        <span className={styles.footnoteLabel}>覆盖资源</span>
        <div className={styles.kindList} aria-label="存储覆盖的资源类型">
          {assetKinds.map((item) => (
            <span key={item} className={styles.kindChip}>
              {item}
            </span>
          ))}
        </div>
      </div>
    </SettingsCard>
    <NfoExportPanel disabled={storageBusy} onBlockingChange={onExportBlockingChange} />
    </>
  )
}
