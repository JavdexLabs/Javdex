import { useRef, useState } from 'react'
import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import FloatingLayer from './FloatingLayer'
import IconButton from './IconButton'
import { Ellipsis } from 'lucide-react'
import { UI_ICON_MD } from './iconDefaults'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { defaultPluginDelay, pluginSourceLabel } from '../settings/settingsDisplay'
import Button from './Button'
import PluginSourceBadge from './PluginSourceBadge'
import styles from './PluginCard.module.css'

function formatPluginVersion(plugin: ScraperPluginDescriptor): string | null {
  if (plugin.source === 'composite' || plugin.version === '组合') return null
  return plugin.version || null
}

function formatPluginName(plugin: ScraperPluginDescriptor): string {
  return plugin.source === 'builtin' ? plugin.name.replace(/（内置）$/u, '') : plugin.name
}

export default function PluginCard({
  plugin,
  allFieldCount,
  isDefault,
  actionsDisabled,
  onEdit,
  onExport,
  onAiDebug,
  onRequestDelete,
  onSetDefault
}: {
  plugin: ScraperPluginDescriptor
  allFieldCount: number
  isDefault: boolean
  actionsDisabled: boolean
  onEdit: () => void
  onExport: () => void
  onAiDebug: () => void
  onRequestDelete: () => void
  onSetDefault: () => void
}): JSX.Element {
  const menuBtnRef = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEscapeKey(() => {
    setMenuOpen(false)
  }, menuOpen)

  const canDebug =
    plugin.debuggable !== false && (plugin.source === 'builtin' || plugin.source === 'user')
  const showMoreMenu = plugin.exportable || plugin.removable || canDebug
  const fieldMapCount = plugin.fieldPluginMap ? Object.keys(plugin.fieldPluginMap).length : 0
  const delayLabel =
    plugin.source === 'composite'
      ? `${fieldMapCount} 字段映射`
      : `间隔 ${Math.round(defaultPluginDelay(plugin.delay).minMs / 1000)}–${Math.round(defaultPluginDelay(plugin.delay).maxMs / 1000)}s`
  const coverage = allFieldCount > 0 ? plugin.supportedFields.length / allFieldCount : 0
  const coveragePct = Math.round(coverage * 100)
  const displayName = formatPluginName(plugin)
  const versionLabel = formatPluginVersion(plugin)
  const summaryLabel = plugin.description || plugin.homepage || ''
  const sourceLabel =
    plugin.source === 'builtin' || plugin.source === 'composite' ? pluginSourceLabel(plugin) : null

  const activateEdit = (): void => {
    if (actionsDisabled) return
    onEdit()
  }

  return (
    <>
      <article
        className={`${styles.card}${isDefault ? ` ${styles.cardDefault}` : ''}${menuOpen ? ` ${styles.cardMenuOpen}` : ''}`}
        data-source={plugin.source}
        role="listitem"
        aria-label={`${displayName}${isDefault ? '，默认插件' : ''}${plugin.configured === false ? '，待配置' : ''}`}
      >
        <div className={styles.body}>
          <div className={styles.titleRow}>
            <h4 className={styles.name} title={displayName}>
              {displayName}
            </h4>
            {isDefault ? (
              <span className={styles.defaultTag}>全局默认</span>
            ) : (
              <button
                type="button"
                className={styles.setDefaultButton}
                disabled={actionsDisabled || plugin.configured === false}
                title={plugin.configured === false ? plugin.disabledReason : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  onSetDefault()
                }}
              >
                设为全局默认
              </button>
            )}
          </div>
          <div className={styles.tags}>
            {sourceLabel && (
              <PluginSourceBadge source={plugin.source}>
                {sourceLabel}
              </PluginSourceBadge>
            )}
            {versionLabel && <span className={styles.version}>{versionLabel}</span>}
            {plugin.requiresConfiguration && (
              <span
                className={styles.availability}
                data-configured={plugin.configured !== false}
                title={plugin.configurationLabel || plugin.disabledReason}
              >
                {plugin.configured === false ? '待配置' : '可用'}
              </span>
            )}
          </div>
          <div className={styles.meta}>
            <span>{delayLabel}</span>
            <span className={styles.fieldCount}>
              字段 {plugin.supportedFields.length}/{allFieldCount}
            </span>
          </div>
          <p className={styles.description} title={summaryLabel || undefined}>
            {summaryLabel || ' '}
          </p>
          <div
            className={styles.fieldBar}
            role="progressbar"
            aria-valuenow={coveragePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`字段支持 ${plugin.supportedFields.length}/${allFieldCount}`}
          >
            <div
              className={`${styles.fieldFill}${coverage >= 1 ? ` ${styles.fieldFillFull}` : ''}`}
              style={{ width: `${coveragePct}%` }}
            />
          </div>
        </div>
        <div className={styles.actions}>
          {plugin.requiresConfiguration && plugin.configured === false ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={actionsDisabled}
              onClick={(event) => {
                event.stopPropagation()
                activateEdit()
              }}
            >
              配置服务端
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={actionsDisabled} onClick={(event) => { event.stopPropagation(); activateEdit() }}>
              配置
            </Button>
          )}
          {showMoreMenu && (
            <span ref={menuBtnRef} className={styles.menuAnchor}>
              <IconButton
                className={styles.iconAction}
                icon={<Ellipsis {...UI_ICON_MD} />}
                label="更多操作"
                disabled={actionsDisabled}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((open) => !open)
                }}
              />
            </span>
          )}
        </div>
      </article>

      {showMoreMenu && (
        <FloatingLayer
          open={menuOpen}
          anchorRef={menuBtnRef}
          side="bottom"
          align="end"
          offset={6}
          className={styles.floatingMenu}
          role="menu"
          onClose={() => setMenuOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!plugin.exportable || actionsDisabled}
            onClick={() => {
              setMenuOpen(false)
              onExport()
            }}
          >
            导出
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canDebug || actionsDisabled}
            onClick={() => {
              setMenuOpen(false)
              onAiDebug()
            }}
          >
            AI 调试
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.dangerItem}
            disabled={!plugin.removable || actionsDisabled}
            onClick={() => {
              setMenuOpen(false)
              onRequestDelete()
            }}
          >
            删除
          </button>
        </FloatingLayer>
      )}
    </>
  )
}
