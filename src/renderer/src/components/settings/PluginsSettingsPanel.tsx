import type { ScraperPluginDescriptor } from '@shared/types'
import { ALL_ACTRESS_SCRAPE_FIELDS, ALL_VIDEO_SCRAPE_FIELDS } from '@shared/types'
import PluginCard from '../PluginCard'
import { SettingsCard, SettingsEmptyPanel, SettingsSectionBlock } from './SettingsPrimitives'
import type { PluginKind } from './PluginConfigModals'

export interface PluginDeleteTarget {
  kind: PluginKind
  name: string
  composite: boolean
}

function PluginEmptyState({
  message,
  onImport,
  onDev
}: {
  message: string
  onImport?: () => void
  onDev?: () => void
}): JSX.Element {
  return (
    <SettingsEmptyPanel variant="dashed" className="plugin-empty-state">
      <span>{message}</span>
      {(onImport || onDev) && (
        <div className="plugin-empty-state-actions">
          {onImport && (
            <button type="button" className="btn btn-sm" onClick={onImport}>
              导入插件
            </button>
          )}
          {onDev && (
            <button type="button" className="btn btn-sm" onClick={onDev}>
              开发助手
            </button>
          )}
        </div>
      )}
    </SettingsEmptyPanel>
  )
}

export default function PluginsSettingsPanel({
  videoUserPlugins,
  actressUserPlugins,
  videoCompositePlugins,
  actressCompositePlugins,
  defaultVideoPluginName,
  defaultActressPluginName,
  pluginBusy,
  onImport,
  onOpenDev,
  onEdit,
  onExport,
  onAiDebug,
  onRequestDelete,
  onSetDefault,
  onCreateComposite
}: {
  videoUserPlugins: ScraperPluginDescriptor[]
  actressUserPlugins: ScraperPluginDescriptor[]
  videoCompositePlugins: ScraperPluginDescriptor[]
  actressCompositePlugins: ScraperPluginDescriptor[]
  defaultVideoPluginName: string
  defaultActressPluginName: string
  pluginBusy: string | null
  onImport: () => void
  onOpenDev: () => void
  onEdit: (kind: PluginKind, plugin: ScraperPluginDescriptor) => void
  onExport: (kind: PluginKind, name: string) => void
  onAiDebug: (kind: PluginKind, name: string) => void
  onRequestDelete: (target: PluginDeleteTarget) => void
  onSetDefault: (kind: PluginKind, name: string) => void
  onCreateComposite: (kind: PluginKind) => void
}): JSX.Element {
  const renderPluginGrid = (
    kind: PluginKind,
    plugins: ScraperPluginDescriptor[],
    allFieldCount: number,
    options: {
      scroll?: boolean
      showEmptyActions?: boolean
      emptyHint: string
      defaultPluginName: string
    }
  ): JSX.Element => {
    if (plugins.length === 0) {
      return (
        <PluginEmptyState
          message={options.emptyHint}
          onImport={options.showEmptyActions ? onImport : undefined}
          onDev={options.showEmptyActions ? onOpenDev : undefined}
        />
      )
    }

    return (
      <div className={options.scroll ? 'plugin-card-scroll' : undefined}>
        <div className="plugin-card-grid" role="list">
          {plugins.map((plugin) => {
            const isDefault = plugin.name === options.defaultPluginName
            return (
              <PluginCard
                key={`${plugin.source}:${plugin.name}`}
                plugin={plugin}
                allFieldCount={allFieldCount}
                isDefault={isDefault}
                actionsDisabled={pluginBusy !== null}
                onEdit={() => onEdit(kind, plugin)}
                onExport={() => onExport(kind, plugin.name)}
                onAiDebug={() => onAiDebug(kind, plugin.name)}
                onRequestDelete={() =>
                  onRequestDelete({
                    kind,
                    name: plugin.name,
                    composite: plugin.source === 'composite'
                  })
                }
                onSetDefault={() => onSetDefault(kind, plugin.name)}
              />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <SettingsCard
      className="plugins-page"
      title="刮削插件"
      hint="点击插件卡片右上角「设为默认」设置默认来源；详情页刮削时仍可临时切换其他站点。"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onOpenDev}>
            开发助手
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={pluginBusy !== null}
            onClick={onImport}
          >
            导入插件
          </button>
        </>
      }
    >
      <SettingsSectionBlock
        title={
          <>
            影片插件
            <em>{videoUserPlugins.length}</em>
          </>
        }
        hint={`默认 ${defaultVideoPluginName}`}
      >
        {renderPluginGrid('video', videoUserPlugins, ALL_VIDEO_SCRAPE_FIELDS.length, {
          scroll: true,
          showEmptyActions: true,
          emptyHint: '暂无影片插件，可导入或使用开发助手创建',
          defaultPluginName: defaultVideoPluginName
        })}
      </SettingsSectionBlock>

      <SettingsSectionBlock
        className="settings-section-divider"
        title={
          <>
            演员插件
            <em>{actressUserPlugins.length}</em>
          </>
        }
        hint={`默认 ${defaultActressPluginName}`}
      >
        {renderPluginGrid('actress', actressUserPlugins, ALL_ACTRESS_SCRAPE_FIELDS.length, {
          scroll: true,
          showEmptyActions: true,
          emptyHint: '暂无演员插件，可导入或使用开发助手创建',
          defaultPluginName: defaultActressPluginName
        })}
      </SettingsSectionBlock>

      <details className="plugins-composite-details settings-section-divider">
        <summary className="plugins-composite-summary">
          <span className="settings-section-block-title">组合插件</span>
          <span className="plugins-composite-meta">
            影片 {videoCompositePlugins.length} · 演员 {actressCompositePlugins.length}
          </span>
        </summary>
        <div className="plugins-composite-body">
          <div className="plugins-composite-block">
            <div className="plugins-composite-head">
              <span>影片</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={pluginBusy !== null}
                onClick={() => onCreateComposite('video')}
              >
                新增
              </button>
            </div>
            {renderPluginGrid('video', videoCompositePlugins, ALL_VIDEO_SCRAPE_FIELDS.length, {
              emptyHint: '暂无影片组合插件',
              defaultPluginName: defaultVideoPluginName
            })}
          </div>
          <div className="plugins-composite-block">
            <div className="plugins-composite-head">
              <span>演员</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={pluginBusy !== null}
                onClick={() => onCreateComposite('actress')}
              >
                新增
              </button>
            </div>
            {renderPluginGrid('actress', actressCompositePlugins, ALL_ACTRESS_SCRAPE_FIELDS.length, {
              emptyHint: '暂无演员组合插件',
              defaultPluginName: defaultActressPluginName
            })}
          </div>
        </div>
      </details>
    </SettingsCard>
  )
}
