import { useMemo, useState } from 'react'
import type { ScraperPluginDescriptor } from '@shared/types'
import { ALL_ACTRESS_SCRAPE_FIELDS, ALL_VIDEO_SCRAPE_FIELDS } from '@shared/types'
import PluginCard from '../PluginCard'
import SelectControl from '../SelectControl'
import { SettingsCard, SettingsEmptyPanel, SettingsSectionBlock } from './SettingsPrimitives'
import type { PluginKind } from './PluginConfigModals'

export interface PluginDeleteTarget {
  kind: PluginKind
  name: string
  composite: boolean
}

type PluginSortMode = 'default' | 'coverage' | 'name'

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase()
}

function pluginSearchText(plugin: ScraperPluginDescriptor): string {
  return [
    plugin.name,
    plugin.description,
    plugin.homepage,
    plugin.source,
    plugin.version,
    ...plugin.supportedFields
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function preparePlugins(
  plugins: ScraperPluginDescriptor[],
  allFieldCount: number,
  defaultPluginName: string,
  query: string,
  sortMode: PluginSortMode
): ScraperPluginDescriptor[] {
  return plugins
    .map((plugin, index) => ({ plugin, index }))
    .filter(({ plugin }) => !query || pluginSearchText(plugin).includes(query))
    .sort((a, b) => {
      const defaultDelta =
        Number(b.plugin.name === defaultPluginName) - Number(a.plugin.name === defaultPluginName)
      if (defaultDelta !== 0) return defaultDelta

      if (sortMode === 'coverage') {
        const coverageDelta =
          b.plugin.supportedFields.length / allFieldCount -
          a.plugin.supportedFields.length / allFieldCount
        if (coverageDelta !== 0) return coverageDelta
      }

      if (sortMode === 'name') {
        const nameDelta = a.plugin.name.localeCompare(b.plugin.name, 'zh-Hans-CN', {
          numeric: true,
          sensitivity: 'base'
        })
        if (nameDelta !== 0) return nameDelta
      }

      return a.index - b.index
    })
    .map(({ plugin }) => plugin)
}

function bestCoverageLabel(plugins: ScraperPluginDescriptor[], allFieldCount: number): string {
  const best = plugins.reduce((max, plugin) => Math.max(max, plugin.supportedFields.length), 0)
  return `字段最高 ${best}/${allFieldCount}`
}

function countLabel(filtered: number, total: number): string {
  return filtered === total ? String(total) : `${filtered}/${total}`
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
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<PluginSortMode>('default')
  const normalizedQuery = normalizeSearch(searchQuery)
  const videoPlugins = useMemo(
    () => [...videoUserPlugins, ...videoCompositePlugins],
    [videoCompositePlugins, videoUserPlugins]
  )
  const actressPlugins = useMemo(
    () => [...actressUserPlugins, ...actressCompositePlugins],
    [actressCompositePlugins, actressUserPlugins]
  )

  const filteredVideoPlugins = useMemo(
    () =>
      preparePlugins(
        videoPlugins,
        ALL_VIDEO_SCRAPE_FIELDS.length,
        defaultVideoPluginName,
        normalizedQuery,
        sortMode
      ),
    [defaultVideoPluginName, normalizedQuery, sortMode, videoPlugins]
  )
  const filteredActressPlugins = useMemo(
    () =>
      preparePlugins(
        actressPlugins,
        ALL_ACTRESS_SCRAPE_FIELDS.length,
        defaultActressPluginName,
        normalizedQuery,
        sortMode
      ),
    [actressPlugins, defaultActressPluginName, normalizedQuery, sortMode]
  )
  const isFiltering = normalizedQuery.length > 0

  const renderPluginGrid = (
    kind: PluginKind,
    plugins: ScraperPluginDescriptor[],
    allFieldCount: number,
    options: {
      scroll?: boolean
      showEmptyActions?: boolean
      emptyHint: string
      filteredEmptyHint?: string
      defaultPluginName: string
    }
  ): JSX.Element => {
    if (plugins.length === 0) {
      return (
        <PluginEmptyState
          message={isFiltering ? (options.filteredEmptyHint ?? '没有符合筛选的插件') : options.emptyHint}
          onImport={!isFiltering && options.showEmptyActions ? onImport : undefined}
          onDev={!isFiltering && options.showEmptyActions ? onOpenDev : undefined}
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
      hint="管理影片 / 演员刮削来源，默认插件用于自动刮削。"
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
      <div className="plugins-toolbar" role="search">
        <label className="plugins-toolbar-search">
          <span>搜索</span>
          <input
            className="text-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="插件名、站点、字段"
          />
        </label>
        <label className="plugins-toolbar-sort">
          <span>排序</span>
          <SelectControl
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as PluginSortMode)}
          >
            <option value="default">默认优先</option>
            <option value="coverage">字段覆盖</option>
            <option value="name">名称</option>
          </SelectControl>
        </label>
        {searchQuery && (
          <button type="button" className="btn btn-sm" onClick={() => setSearchQuery('')}>
            清空
          </button>
        )}
      </div>

      <SettingsSectionBlock
        title={
          <>
            影片插件
            <em>{countLabel(filteredVideoPlugins.length, videoPlugins.length)}</em>
          </>
        }
        hint={`默认 ${defaultVideoPluginName} · ${bestCoverageLabel(videoPlugins, ALL_VIDEO_SCRAPE_FIELDS.length)}`}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            disabled={pluginBusy !== null}
            onClick={() => onCreateComposite('video')}
          >
            新增组合
          </button>
        }
      >
        {renderPluginGrid('video', filteredVideoPlugins, ALL_VIDEO_SCRAPE_FIELDS.length, {
          scroll: true,
          showEmptyActions: true,
          emptyHint: '暂无影片插件，可导入或使用开发助手创建',
          filteredEmptyHint: '没有符合筛选的影片插件',
          defaultPluginName: defaultVideoPluginName
        })}
      </SettingsSectionBlock>

      <SettingsSectionBlock
        className="settings-section-divider"
        title={
          <>
            演员插件
            <em>{countLabel(filteredActressPlugins.length, actressPlugins.length)}</em>
          </>
        }
        hint={`默认 ${defaultActressPluginName} · ${bestCoverageLabel(actressPlugins, ALL_ACTRESS_SCRAPE_FIELDS.length)}`}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            disabled={pluginBusy !== null}
            onClick={() => onCreateComposite('actress')}
          >
            新增组合
          </button>
        }
      >
        {renderPluginGrid('actress', filteredActressPlugins, ALL_ACTRESS_SCRAPE_FIELDS.length, {
          scroll: true,
          showEmptyActions: true,
          emptyHint: '暂无演员插件，可导入或使用开发助手创建',
          filteredEmptyHint: '没有符合筛选的演员插件',
          defaultPluginName: defaultActressPluginName
        })}
      </SettingsSectionBlock>
    </SettingsCard>
  )
}
