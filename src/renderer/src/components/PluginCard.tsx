import { useEffect, useRef, useState } from 'react'
import type { ScraperPluginDescriptor } from '@shared/types'
import FloatingLayer from './FloatingLayer'
import IconButton from './IconButton'
import { Ellipsis, Pencil } from 'lucide-react'
import { UI_ICON_MD } from './iconDefaults'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { defaultPluginDelay, pluginSourceLabel } from '../settings/settingsDisplay'

function formatPluginVersion(plugin: ScraperPluginDescriptor): string | null {
  if (plugin.source === 'composite' || plugin.version === '组合') return null
  return plugin.version || null
}

const TOOLTIP_SHOW_DELAY_MS = 140

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
  const cardRef = useRef<HTMLElement>(null)
  const menuBtnRef = useRef<HTMLSpanElement>(null)
  const tooltipTimerRef = useRef<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  useEscapeKey(() => {
    setMenuOpen(false)
    setTooltipOpen(false)
  }, menuOpen || tooltipOpen)

  useEffect(() => {
    if (!menuOpen) return
    setTooltipOpen(false)
  }, [menuOpen])

  useEffect(
    () => () => {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current)
      }
    },
    []
  )

  const showMoreMenu =
    plugin.exportable || plugin.removable || plugin.source === 'builtin' || plugin.source === 'user'
  const fieldMapCount = plugin.fieldPluginMap ? Object.keys(plugin.fieldPluginMap).length : 0
  const delayLabel =
    plugin.source === 'composite'
      ? `${fieldMapCount} 字段映射`
      : `间隔 ${Math.round(defaultPluginDelay(plugin.delay).minMs / 1000)}–${Math.round(defaultPluginDelay(plugin.delay).maxMs / 1000)}s`
  const coverage = allFieldCount > 0 ? plugin.supportedFields.length / allFieldCount : 0
  const coveragePct = Math.round(coverage * 100)
  const versionLabel = formatPluginVersion(plugin)
  const hasTooltip = Boolean(plugin.description || plugin.homepage)

  const activateEdit = (): void => {
    if (actionsDisabled) return
    setIsHovered(false)
    onEdit()
  }

  const handleMouseEnter = (): void => {
    setIsHovered(true)
    openTooltip()
  }

  const handleMouseLeave = (): void => {
    setIsHovered(false)
    closeTooltip()
  }

  const revealActions = isHovered || menuOpen

  const openTooltip = (): void => {
    if (menuOpen || !hasTooltip) return
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current)
    }
    tooltipTimerRef.current = window.setTimeout(() => {
      setTooltipOpen(true)
      tooltipTimerRef.current = null
    }, TOOLTIP_SHOW_DELAY_MS)
  }

  const closeTooltip = (): void => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
    setTooltipOpen(false)
  }

  return (
    <>
      <article
        ref={cardRef}
        className={`plugin-card plugin-card--${plugin.source}${isDefault ? ' plugin-card--default' : ''}${
          revealActions ? ' plugin-card--hovered' : ''
        }`}
        role="listitem"
        aria-label={`${plugin.name}${isDefault ? '，默认插件' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="plugin-card-body">
          <div className="plugin-card-title-row">
            <h4 className="plugin-card-name" title={plugin.name}>
              {plugin.name}
            </h4>
            {isDefault ? (
              <span className="plugin-card-default-tag">默认</span>
            ) : (
              <button
                type="button"
                className="plugin-card-set-default-btn"
                disabled={actionsDisabled}
                onClick={(e) => {
                  e.stopPropagation()
                  onSetDefault()
                }}
              >
                设为默认
              </button>
            )}
          </div>
          <div className="plugin-card-tags">
            <span className={`plugin-source-badge plugin-source-badge--${plugin.source}`}>
              {pluginSourceLabel(plugin)}
            </span>
            {versionLabel && <span className="plugin-version">{versionLabel}</span>}
          </div>
          <div className="plugin-card-meta">
            <span>{delayLabel}</span>
            <span>
              字段 {plugin.supportedFields.length}/{allFieldCount}
            </span>
          </div>
          <div
            className="plugin-card-field-bar"
            role="progressbar"
            aria-valuenow={coveragePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`字段支持 ${plugin.supportedFields.length}/${allFieldCount}`}
          >
            <div
              className={`plugin-card-field-fill${coverage >= 1 ? ' plugin-card-field-fill--full' : ''}`}
              style={{ width: `${coveragePct}%` }}
            />
          </div>
        </div>
        <div className="plugin-card-actions">
          <IconButton
            className="plugin-card-icon-action"
            icon={<Pencil {...UI_ICON_MD} />}
            label="编辑"
            disabled={actionsDisabled}
            onClick={(e) => {
              e.stopPropagation()
              activateEdit()
            }}
          />
          {showMoreMenu && (
            <span ref={menuBtnRef} className="plugin-card-menu-anchor">
              <IconButton
                className="plugin-card-icon-action"
                icon={<Ellipsis {...UI_ICON_MD} />}
                label="更多操作"
                disabled={actionsDisabled}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTooltip()
                  setMenuOpen((open) => !open)
                }}
              />
            </span>
          )}
        </div>
      </article>

      {hasTooltip && (
        <FloatingLayer
          open={tooltipOpen && !menuOpen}
          anchorRef={cardRef}
          side="top"
          align="center"
          offset={10}
          className="plugin-floating-tooltip"
          role="tooltip"
        >
          {plugin.description && <p>{plugin.description}</p>}
          {plugin.homepage && <span className="plugin-floating-tooltip-url">{plugin.homepage}</span>}
        </FloatingLayer>
      )}

      {showMoreMenu && (
        <FloatingLayer
          open={menuOpen}
          anchorRef={menuBtnRef}
          side="bottom"
          align="end"
          offset={6}
          className="plugin-floating-menu"
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
            disabled={!(plugin.source === 'user' || plugin.source === 'builtin') || actionsDisabled}
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
            className="danger"
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
