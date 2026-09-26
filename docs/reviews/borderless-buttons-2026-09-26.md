# 无边框按钮排查清单

范围：桌面共享 ghost 文字按钮、IconButton 使用点，以及桌面/网页端透明边框样式。仅“使用系统默认播放器”已改为默认带边框；其余均未修改。

## 同款文字按钮：60 个源码使用点

数量为源码位置，不是运行时按钮数量；列表渲染可能产生多个按钮，页面样式覆盖也可能改变最终外观。

### ActressFaceScanModal · 44
[打开源码](../../apps/desktop/src/renderer/src/components/ActressFaceScanModal.tsx#L44)
```tsx
<Button
            type="button"
            variant="ghost"
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? '正在取消…' : '取消扫描'}
          </Button>
```

### ActressFilterPopover · 117
[打开源码](../../apps/desktop/src/renderer/src/components/ActressFilterPopover.tsx#L117)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={onReset}>
          重置
        </Button>
```

### ClassificationImageModal · 273
[打开源码](../../apps/desktop/src/renderer/src/components/ClassificationImageModal.tsx#L273)
```tsx
<Button
                type="button"
                variant="ghost"

                size="sm"
                onClick={() => {
                  remoteRequestRef.current += 1;
                  setLoadingRemote(false);
                  clearObjectUrl();
                  setPending(null);
                  setPreviewUrl(assetUrl(fallbackCoverPath));
                  setPreviewLabel(fallbackCoverPath ? "动态回退" : "暂无图片");
                }}
              >
                <Trash2 {...UI_ICON_SM} aria-hidden />
                移除正式主图
              </Button>
```

### ClassificationImageModal · 337
[打开源码](../../apps/desktop/src/renderer/src/components/ClassificationImageModal.tsx#L337)
```tsx
<Button
                    type="button"
                    variant="ghost"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload {...UI_ICON_SM} aria-hidden />
                    选择图片
                  </Button>
```

### ClassificationImageModal · 385
[打开源码](../../apps/desktop/src/renderer/src/components/ClassificationImageModal.tsx#L385)
```tsx
<Button
                    type="button"
                    variant="ghost"
                    disabled={loadingRemote}
                    onClick={() => void previewRemote()}
                  >
                    {loadingRemote ? "加载中…" : "加载并预览"}
                  </Button>
```

### DirectorEditModal · 188
[打开源码](../../apps/desktop/src/renderer/src/components/DirectorEditModal.tsx#L188)
```tsx
<Button
              type="button"
              variant="ghost"

              size="sm"
              className="organization-link-add"
              onClick={() => {
                setDraft({
                  ...draft,
                  links: [...draft.links, { label: '', url: '' }],
                })
                appendLinkKey()
              }}
            >
              <Plus {...UI_ICON_SM} />
              添加链接
            </Button>
```

### ImageImportField · 79
[打开源码](../../apps/desktop/src/renderer/src/components/ImageImportField.tsx#L79)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={clearPick}>
          取消选择
        </Button>
```

### LibraryFilterPopover · 165
[打开源码](../../apps/desktop/src/renderer/src/components/LibraryFilterPopover.tsx#L165)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={onReset}>
          重置
        </Button>
```

### OrganizationEditModal · 251
[打开源码](../../apps/desktop/src/renderer/src/components/OrganizationEditModal.tsx#L251)
```tsx
<Button
              type="button"
              variant="ghost"

              size="sm"
              className="organization-link-add"
              onClick={() => {
                setDraft({ ...draft, links: [...draft.links, { label: '', url: '' }] })
                appendLinkKey()
              }}
            >
              <Plus {...UI_ICON_SM} aria-hidden />
              添加链接
            </Button>
```

### PendingDecisionParts · 196
[打开源码](../../apps/desktop/src/renderer/src/components/PendingDecisionParts.tsx#L196)
```tsx
<Button
        ref={anchorRef}
        variant="ghost"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown {...UI_ICON_SM} aria-hidden />
      </Button>
```

### PlaylistCreateModal · 94
[打开源码](../../apps/desktop/src/renderer/src/components/PlaylistCreateModal.tsx#L94)
```tsx
<Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveCover((value) => !value)}
                  >
                    {removeCover ? '撤销移除封面' : '移除当前封面'}
                  </Button>
```

### PlaylistResourceFilterPopover · 61
[打开源码](../../apps/desktop/src/renderer/src/components/PlaylistResourceFilterPopover.tsx#L61)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
          重置
        </Button>
```

### RelatedLinksEditor · 90
[打开源码](../../apps/desktop/src/renderer/src/components/RelatedLinksEditor.tsx#L90)
```tsx
<Button
          type="button"
          variant="ghost"
          size="sm"
          className="organization-link-add"
          disabled={disabled}
          onClick={() => {
            onChange([...links, { label: '', url: '' }])
            appendLinkKey()
          }}
        >
          <Plus {...UI_ICON_SM} />
          添加链接
        </Button>
```

### SeriesEditModal · 292
[打开源码](../../apps/desktop/src/renderer/src/components/SeriesEditModal.tsx#L292)
```tsx
<Button
              type="button"
              variant="ghost"

              size="sm"
              className="organization-link-add"
              onClick={() => {
                setDraft({ ...draft, links: [...draft.links, { label: '', url: '' }] })
                appendLinkKey()
              }}
            >
              <Plus {...UI_ICON_SM} aria-hidden />
              添加链接
            </Button>
```

### VideoResourceImportModal · 686
[打开源码](../../apps/desktop/src/renderer/src/components/VideoResourceImportModal.tsx#L686)
```tsx
<Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.addButton}
                  disabled={saving}
                  onClick={() => {
                    setPlaybackDrafts((current) => [...current, emptyPlaybackDraft()])
                    playbackKeys.appendLinkKey()
                  }}
                >
                  <Plus {...UI_ICON_SM} />
                  添加链接
                </Button>
```

### AgentMetadataCollectorContext · 509
[打开源码](../../apps/desktop/src/renderer/src/components/agentMetadata/AgentMetadataCollectorContext.tsx#L509)
```tsx
<Button variant="ghost" disabled={busy} onClick={() => setConfirmation('discard')}>丢弃草稿</Button>
```

### PluginDevConfigRail · 224
[打开源码](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConfigRail.tsx#L224)
```tsx
<Button
              type="button"
              variant="ghost"
              className="plugin-dev-target-picker-button"
              disabled={busy}
              onClick={() => setShowTargetPicker(true)}
            >
              从媒体库选择
            </Button>
```

### PluginDevConversation · 286
[打开源码](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConversation.tsx#L286)
```tsx
<Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.userPromptAction}
        disabled={busy}
        onClick={() => onApprovalDecision('deny')}
      >
        拒绝
      </Button>
```

### PluginDevConversation · 341
[打开源码](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConversation.tsx#L341)
```tsx
<Button
          key={option.id}
          type="button"
          variant="ghost"
          size="sm"
          className={styles.userPromptAction}
          disabled={busy}
          title={option.description}
          onClick={() => onFieldMapping(option.id)}
        >
          {option.label}
        </Button>
```

### PluginDevConversation · 584
[打开源码](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConversation.tsx#L584)
```tsx
<Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canClearHistory}
                title="关闭全部历史会话，下次进入时不再自动恢复"
                onClick={onClearHistory}
              >
                <Trash2 {...UI_ICON_SM} aria-hidden />
                {clearHistoryBusy ? '清除中…' : '清除会话'}
              </Button>
```

### PluginDevConversation · 595
[打开源码](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConversation.tsx#L595)
```tsx
<Button
                type="button"
                variant="ghost"

                size="sm"
                disabled={!canExportWorkLog || exportWorkLogBusy}
                title="导出完整 Agent 工作日志（JSON）"
                onClick={onExportWorkLog}
              >
                <Download {...UI_ICON_SM} aria-hidden />
                {exportWorkLogBusy ? '导出中…' : '导出日志'}
              </Button>
```

### AppearanceSettingsPanel · 635
[打开源码](../../apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPanel.tsx#L635)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </Button>
```

### AppearanceSettingsPanel · 645
[打开源码](../../apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPanel.tsx#L645)
```tsx
<Button
                    type="button"
                    variant="ghost"

                    size="sm"
                    disabled={avatarAutoCropBatch.state.status === 'cancelling'}
                    onClick={avatarAutoCropBatch.cancel}
                  >
                    {avatarAutoCropBatch.state.status === 'cancelling' ? '正在停止…' : '停止'}
                  </Button>
```

### AppearanceSettingsPanel · 661
[打开源码](../../apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPanel.tsx#L661)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </Button>
```

### BackupSettingsPanel · 247
[打开源码](../../apps/desktop/src/renderer/src/components/settings/BackupSettingsPanel.tsx#L247)
```tsx
<Button size="sm" variant="ghost" aria-expanded={expandedId === item.id} aria-controls={`${detailsPrefix}-${item.id}`} onClick={() => setExpandedId(current => current === item.id ? null : item.id)}>{expandedId === item.id ? <ChevronDown {...UI_ICON_SM} /> : <ChevronRight {...UI_ICON_SM} />}{expandedId === item.id ? '收起详情' : '展开详情'}</Button>
```

### BatchSettingsPanel · 83
[打开源码](../../apps/desktop/src/renderer/src/components/settings/BatchSettingsPanel.tsx#L83)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={onOpenPending}>
              查看待确认
            </Button>
```

### CompositeConfigModal · 195
[打开源码](../../apps/desktop/src/renderer/src/components/settings/CompositeConfigModal.tsx#L195)
```tsx
<Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setMapping(undo)
                setUndo(null)
                setNotice('已撤销上次批量应用。')
              }}
            >
              撤销应用
            </Button>
```

### NetworkSettingsPanel · 224
[打开源码](../../apps/desktop/src/renderer/src/components/settings/NetworkSettingsPanel.tsx#L224)
```tsx
<Button
            size="sm"
            variant="ghost"
            className={
              feedback.detail ? styles.detailsButton : styles.detailsHidden
            }
            tabIndex={feedback.detail ? 0 : -1}
            aria-hidden={!feedback.detail}
            onClick={() => setDetailsOpen(true)}
          >
            查看详情
          </Button>
```

### NfoExportPanel · 451
[打开源码](../../apps/desktop/src/renderer/src/components/settings/NfoExportPanel.tsx#L451)
```tsx
<Button size="sm" variant="ghost" disabled={page === 0} onClick={() => changePage(page - 1)}>上一页</Button>
```

### NfoExportPanel · 452
[打开源码](../../apps/desktop/src/renderer/src/components/settings/NfoExportPanel.tsx#L452)
```tsx
<Button size="sm" variant="ghost" disabled={end >= count} onClick={() => changePage(page + 1)}>下一页</Button>
```

### SettingsOverviewPanel · 343
[打开源码](../../apps/desktop/src/renderer/src/components/settings/SettingsOverviewPanel.tsx#L343)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={onOpenPending}>
                查看待确认
              </Button>
```

### SettingsOverviewPanel · 506
[打开源码](../../apps/desktop/src/renderer/src/components/settings/SettingsOverviewPanel.tsx#L506)
```tsx
<Button
                      type="button"
                      variant="ghost"

                      size="sm"
                      onClick={notice.secondaryAction}
                    >
                      {notice.secondaryActionLabel}
                    </Button>
```

### StorageSettingsPanel · 122
[打开源码](../../apps/desktop/src/renderer/src/components/settings/StorageSettingsPanel.tsx#L122)
```tsx
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
```

### WebAccessPanel · 312
[打开源码](../../apps/desktop/src/renderer/src/components/settings/WebAccessPanel.tsx#L312)
```tsx
<Button size="sm" variant="ghost" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>{helpOpen ? '收起说明' : '无法连接？'}</Button>
```

### WebAccessPanel · 314
[打开源码](../../apps/desktop/src/renderer/src/components/settings/WebAccessPanel.tsx#L314)
```tsx
<Button size="sm" variant="ghost" onClick={() => setAddressFeedback("")}>关闭提示</Button>
```

### DesktopSessionOverlay · 68
[打开源码](../../apps/desktop/src/renderer/src/desktop/DesktopSessionOverlay.tsx#L68)
```tsx
<Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                void reconnect()
                  .catch((reason) => setError((reason as Error).message))
                  .finally(() => setBusy(false))
              }}
            >
              重新连接
            </Button>
```

### DirectorDetailPage · 145
[打开源码](../../apps/desktop/src/renderer/src/pages/DirectorDetailPage.tsx#L145)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setMergingDirector(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并导演
                </Button>
```

### DirectorDetailPage · 155
[打开源码](../../apps/desktop/src/renderer/src/pages/DirectorDetailPage.tsx#L155)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditingImage(true)}
                >
                  <ImagePlus {...UI_ICON_SM} aria-hidden />
                  管理主图
                </Button>
```

### DirectorDetailPage · 165
[打开源码](../../apps/desktop/src/renderer/src/pages/DirectorDetailPage.tsx#L165)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil {...UI_ICON_SM} />
                  编辑资料
                </Button>
```

### DirectorDetailPage · 175
[打开源码](../../apps/desktop/src/renderer/src/pages/DirectorDetailPage.tsx#L175)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeletingDirector(true)}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  删除导演
                </Button>
```

### GlobalSearchPage · 113
[打开源码](../../apps/desktop/src/renderer/src/pages/GlobalSearchPage.tsx#L113)
```tsx
<Button
            className={styles.libraryFilter}
            size="sm"
            variant="ghost"
            aria-pressed={selectedLibraryIds.length === 0}
            onClick={() =>
              setSearchParams(
                (current) =>
                  patchSearchParams(current, { [GLOBAL_SEARCH_LIBRARY_PARAM]: null }),
                { replace: true }
              )
            }
          >
            全部
          </Button>
```

### GlobalSearchPage · 133
[打开源码](../../apps/desktop/src/renderer/src/pages/GlobalSearchPage.tsx#L133)
```tsx
<Button
                  key={library.id}
                  className={styles.libraryFilter}
                  size="sm"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => toggleLibrary(library.id)}
                >
                  <span
                    className={styles.libraryDot}
                    style={mediaLibraryIdentityStyle(library.color)}
                    aria-hidden
                  />
                  {library.name}
                </Button>
```

### OrganizationDetailPage · 229
[打开源码](../../apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx#L229)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditingImage(true)}
                >
                  <ImagePlus {...UI_ICON_SM} aria-hidden />
                  管理主图
                </Button>
```

### OrganizationDetailPage · 239
[打开源码](../../apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx#L239)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setMergingOrganization(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并机构
                </Button>
```

### OrganizationDetailPage · 247
[打开源码](../../apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx#L247)
```tsx
<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  <Pencil {...UI_ICON_SM} aria-hidden />
                  编辑资料
                </Button>
```

### OrganizationDetailPage · 253
[打开源码](../../apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx#L253)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeleteAction('role')}
                >
                  <BadgeMinus {...UI_ICON_SM} aria-hidden />
                  移除{FACET_LABEL[role]}角色
                </Button>
```

### OrganizationDetailPage · 263
[打开源码](../../apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx#L263)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeleteAction('organization')}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  完整删除机构
                </Button>
```

### PendingActressConflictPane · 597
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L597)
```tsx
<Button
                    variant="ghost"
                    disabled={resolving}
                    onClick={() => detail.requestDiscard(selectedCandidate)}
                  >
                    <Trash2 {...UI_ICON_SM} aria-hidden />
                    {isConflict ? '丢弃这份错误匹配' : '丢弃这份结果'}
                  </Button>
```

### PendingActressConflictPane · 608
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L608)
```tsx
<Button
                      variant="ghost"
                      disabled={!editSourceName || resolving}
                      onClick={detail.openEditName}
                    >
                      <Pencil {...UI_ICON_SM} aria-hidden />修改返回名称
                    </Button>
```

### PendingActressConflictPane · 615
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L615)
```tsx
<Button
                      variant="ghost"
                      disabled={mergeActors.length < 2 || resolving}
                      onClick={detail.openMerge}
                    >
                      <GitMerge {...UI_ICON_SM} aria-hidden />合并演员档案
                    </Button>
```

### PendingActressConflictPane · 621
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L621)
```tsx
<Button variant="ghost" disabled={resolving} onClick={detail.openIllegalName}>
                      <Ban {...UI_ICON_SM} aria-hidden />这不是演员名称
                    </Button>
```

### PendingResourceIdentityPane · 79
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingResourceIdentityPane.tsx#L79)
```tsx
<Button variant="ghost" disabled={busy != null} onClick={() => setDiscardOpen(true)}>
                丢弃待办
              </Button>
```

### PendingScrapePane · 346
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingScrapePane.tsx#L346)
```tsx
<Button
                variant="ghost"
                disabled={busy}
                onClick={() => navigateToVideoDetail(navigate, location, pending.videoId)}
              >
                查看影片
              </Button>
```

### PendingScrapePane · 352
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingScrapePane.tsx#L352)
```tsx
<Button variant="ghost" disabled={busy} onClick={() => setDiscardOpen(true)}>
                <Trash2 {...UI_ICON_SM} aria-hidden />丢弃全部候选
              </Button>
```

### PendingScrapePane · 407
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingScrapePane.tsx#L407)
```tsx
<Button
              variant="ghost"
              size="sm"
              disabled={!primaryResource}
              onClick={() => void openPrimaryResource('play')}
            >
              <Play {...UI_ICON_SM} aria-hidden />
              播放
            </Button>
```

### PendingScrapePane · 416
[打开源码](../../apps/desktop/src/renderer/src/pages/PendingScrapePane.tsx#L416)
```tsx
<Button variant="ghost" size="sm" onClick={() => void openPrimaryResource('reveal')}>
                <FolderOpen {...UI_ICON_SM} aria-hidden />
                所在文件夹
              </Button>
```

### SeriesDetailPage · 198
[打开源码](../../apps/desktop/src/renderer/src/pages/SeriesDetailPage.tsx#L198)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setMergingSeries(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并系列
                </Button>
```

### SeriesDetailPage · 208
[打开源码](../../apps/desktop/src/renderer/src/pages/SeriesDetailPage.tsx#L208)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditingImage(true)}
                >
                  <ImagePlus {...UI_ICON_SM} aria-hidden />
                  管理主图
                </Button>
```

### SeriesDetailPage · 218
[打开源码](../../apps/desktop/src/renderer/src/pages/SeriesDetailPage.tsx#L218)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil {...UI_ICON_SM} aria-hidden />
                  编辑资料
                </Button>
```

### SeriesDetailPage · 228
[打开源码](../../apps/desktop/src/renderer/src/pages/SeriesDetailPage.tsx#L228)
```tsx
<Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeletingSeries(true)}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  删除系列
                </Button>
```

## 图标按钮：51 个源码使用点

这类控件默认透明边框；hover 由全局及页面样式决定，部分始终无边框，需与文字操作按钮分开决定。
| 组件 | 行号 | 标签 |
|---|---|---|
| ActressGalleryPanel | [206](../../apps/desktop/src/renderer/src/components/ActressGalleryPanel.tsx#L206) | "导入写真" |
| DetailActionBar | [105](../../apps/desktop/src/renderer/src/components/DetailActionBar.tsx#L105) | {action.label} |
| DetailActionBar | [121](../../apps/desktop/src/renderer/src/components/DetailActionBar.tsx#L121) | {'\u66f4\u591a'} |
| DirectorEditModal | [144](../../apps/desktop/src/renderer/src/components/DirectorEditModal.tsx#L144) | {`上移链接 ${index + 1}`} |
| DirectorEditModal | [157](../../apps/desktop/src/renderer/src/components/DirectorEditModal.tsx#L157) | {`下移链接 ${index + 1}`} |
| DirectorEditModal | [170](../../apps/desktop/src/renderer/src/components/DirectorEditModal.tsx#L170) | {`删除链接 ${index + 1}`} |
| ImagePreviewLightbox | [607](../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox.tsx#L607) | "缩小" |
| ImagePreviewLightbox | [614](../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox.tsx#L614) | "放大" |
| ImagePreviewLightbox | [620](../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox.tsx#L620) | "还原视图" |
| ImagePreviewLightbox | [628](../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox.tsx#L628) | "关闭预览" |
| ListMaintenanceBanner | [58](../../apps/desktop/src/renderer/src/components/ListMaintenanceBanner.tsx#L58) | "关闭提示" |
| MediaLibraryCreateModal | [397](../../apps/desktop/src/renderer/src/components/MediaLibraryCreateModal.tsx#L397) | {`移除来源目录 ${path}`} |
| MediaLibraryNav | [112](../../apps/desktop/src/renderer/src/components/MediaLibraryNav.tsx#L112) | "新建媒体库" |
| MediaTileActionButton | [35](../../apps/desktop/src/renderer/src/components/MediaTileActionButton.tsx#L35) | {label} |
| Modal | [209](../../apps/desktop/src/renderer/src/components/Modal.tsx#L209) | "关闭" |
| OrganizationEditModal | [207](../../apps/desktop/src/renderer/src/components/OrganizationEditModal.tsx#L207) | {`上移链接 ${index + 1}`} |
| OrganizationEditModal | [220](../../apps/desktop/src/renderer/src/components/OrganizationEditModal.tsx#L220) | {`下移链接 ${index + 1}`} |
| OrganizationEditModal | [233](../../apps/desktop/src/renderer/src/components/OrganizationEditModal.tsx#L233) | {`移除链接 ${index + 1}`} |
| PluginCard | [162](../../apps/desktop/src/renderer/src/components/PluginCard.tsx#L162) | "更多操作" |
| PosterCard | [201](../../apps/desktop/src/renderer/src/components/PosterCard.tsx#L201) | {`编辑 ${video.code} 元数据`} |
| PosterCard | [215](../../apps/desktop/src/renderer/src/components/PosterCard.tsx#L215) | {`${video.code} 功能菜单`} |
| RelatedLinksEditor | [54](../../apps/desktop/src/renderer/src/components/RelatedLinksEditor.tsx#L54) | {`上移链接 ${index + 1}`} |
| RelatedLinksEditor | [64](../../apps/desktop/src/renderer/src/components/RelatedLinksEditor.tsx#L64) | {`下移链接 ${index + 1}`} |
| RelatedLinksEditor | [74](../../apps/desktop/src/renderer/src/components/RelatedLinksEditor.tsx#L74) | {`删除链接 ${index + 1}`} |
| ScrollToTopButton | [19](../../apps/desktop/src/renderer/src/components/ScrollToTopButton.tsx#L19) | "回到顶部" |
| SelectionToolbar | [52](../../apps/desktop/src/renderer/src/components/SelectionToolbar.tsx#L52) | {clearLabel} |
| SeriesEditModal | [248](../../apps/desktop/src/renderer/src/components/SeriesEditModal.tsx#L248) | {`上移链接 ${index + 1}`} |
| SeriesEditModal | [261](../../apps/desktop/src/renderer/src/components/SeriesEditModal.tsx#L261) | {`下移链接 ${index + 1}`} |
| SeriesEditModal | [274](../../apps/desktop/src/renderer/src/components/SeriesEditModal.tsx#L274) | {`移除链接 ${index + 1}`} |
| SortSwitch | [47](../../apps/desktop/src/renderer/src/components/SortSwitch.tsx#L47) | {`${active?.title ?? active?.label ?? label}${dir === 'asc' ? '升序' : '降序'}`} |
| VideoDetailMeta | [291](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L291) | "播放此文件" |
| VideoDetailMeta | [298](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L298) | "更多" |
| VideoDetailMeta | [460](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L460) | {copied ? '已复制链接' : '复制链接'} |
| VideoDetailMeta | [466](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L466) | {`打开${kind}`} |
| VideoDetailMeta | [473](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L473) | "更多" |
| VideoDetailMeta | [665](../../apps/desktop/src/renderer/src/components/VideoDetailMeta.tsx#L665) | "添加资源" |
| VideoResourceImportModal | [596](../../apps/desktop/src/renderer/src/components/VideoResourceImportModal.tsx#L596) | {`删除资源链接 ${index + 1}`} |
| VideoSampleGallery | [193](../../apps/desktop/src/renderer/src/components/VideoSampleGallery.tsx#L193) | "导入样张" |
| VideoTagPanel | [180](../../apps/desktop/src/renderer/src/components/VideoTagPanel.tsx#L180) | "添加自定义标签" |
| PluginDevPanel | [1257](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevPanel.tsx#L1257) | "查看代码" |
| PluginDevPanel | [1268](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevPanel.tsx#L1268) | "连接设置" |
| BatchTaskControls | [99](../../apps/desktop/src/renderer/src/components/settings/BatchTaskControls.tsx#L99) | {`${pauseText}${scopeLabel}${batchTaskText}`} |
| BatchTaskControls | [108](../../apps/desktop/src/renderer/src/components/settings/BatchTaskControls.tsx#L108) | {`${discardText}${scopeLabel}${batchTaskText}`} |
| BatchTaskControls | [121](../../apps/desktop/src/renderer/src/components/settings/BatchTaskControls.tsx#L121) | {`${discardText}${scopeLabel}${batchTaskText}`} |
| LibraryScanAuditPanel | [168](../../apps/desktop/src/renderer/src/components/settings/LibraryScanAuditPanel.tsx#L168) | "复制完整路径" |
| LibraryScanAuditPanel | [176](../../apps/desktop/src/renderer/src/components/settings/LibraryScanAuditPanel.tsx#L176) | "在文件夹中显示" |
| SettingsOverviewPanel | [323](../../apps/desktop/src/renderer/src/components/settings/SettingsOverviewPanel.tsx#L323) | {openLabel} |
| UnrecognizedRow | [173](../../apps/desktop/src/renderer/src/components/settings/UnrecognizedRow.tsx#L173) | "复制完整路径" |
| UnrecognizedRow | [181](../../apps/desktop/src/renderer/src/components/settings/UnrecognizedRow.tsx#L181) | "在文件夹中显示" |
| PendingActressConflictPane | [174](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L174) | {`查看「${name}」的详情`} |
| PendingActressConflictPane | [691](../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane.tsx#L691) | "重新选择演员" |

## 透明边框样式候选

以下为样式审计候选，含页签、选项、资源行和装饰元素；不能全部当作普通按钮直接替换。

[styles.css:279](../../apps/desktop/src/renderer/src/styles.css#L279)
```css
::-webkit-scrollbar-thumb {
  background: var(--bg-3);
  background-clip: content-box;
  border: 2px solid transparent;
  border-radius: 6px;
}
```

[Button.module.css:70](../../apps/desktop/src/renderer/src/components/Button.module.css#L70)
```css
.ghost {
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
}
```

[IconButton.module.css:1](../../apps/desktop/src/renderer/src/components/IconButton.module.css#L1)
```css
.root {
  --icon-glyph-size: 14px;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: var(--target-min);
  min-height: var(--target-min);
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  appearance: none;
  background: transparent;
  color: inherit;
  line-height: 0;
  cursor: pointer;
  transition:
    background var(--motion-fast),
    border-color var(--motion-fast),
    color var(--motion-fast);
}
```

[PluginDevPanel.module.css:11](../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevPanel.module.css#L11)
```css
.kindButton {
  flex: 0 0 auto;
  min-width: 52px;
  min-height: var(--control-h-sm);
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--settings-fs-secondary, 12px);
  font-weight: var(--settings-fw-title, 700);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--motion-fast),
    border-color var(--motion-fast),
    color var(--motion-fast);
}
```

[ModelProvidersPanel.module.css:68](../../apps/desktop/src/renderer/src/components/settings/ModelProvidersPanel.module.css#L68)
```css
.providerRow,
.disclosure,
.availableProvider {
  min-height: var(--control-h-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
}
```

[ModelSettingsPanel.module.css:16](../../apps/desktop/src/renderer/src/components/settings/ModelSettingsPanel.module.css#L16)
```css
.tab {
  min-height: var(--control-h-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
}
```

[PendingCenterPage.module.css:153](../../apps/desktop/src/renderer/src/pages/PendingCenterPage.module.css#L153)
```css
.railItem {
  width: 100%;
  min-height: 54px;
  padding: 7px 9px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  transition:
    background var(--motion-fast),
    border-color var(--motion-fast);
}
```

[media-details.css:169](../../apps/desktop/src/renderer/src/styles/media-details.css#L169)
```css
.app-shell--with-background .detail-meta-section {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
```

[media-details.css:750](../../apps/desktop/src/renderer/src/styles/media-details.css#L750)
```css
.app-shell--with-background .detail-section {
  background: transparent;
  border-color: transparent;
}
```

[media-details.css:1638](../../apps/desktop/src/renderer/src/styles/media-details.css#L1638)
```css
.image-preview-thumb {
  position: relative;
  flex-shrink: 0;
  height: 72px;
  min-width: 48px;
  max-width: 96px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-control) 65%, transparent);
  overflow: hidden;
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity var(--motion-fast),
    border-color var(--motion-fast);
}
```

[settings-overview.css:57](../../apps/desktop/src/renderer/src/styles/settings-overview.css#L57)
```css
.settings-group-tab {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-h-sm);
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--settings-fs-secondary, 12px);
  font-weight: var(--settings-fw-title, 700);
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    background var(--motion-fast),
    border-color var(--motion-fast),
    color var(--motion-fast);
}
```

[settings-overview.css:955](../../apps/desktop/src/renderer/src/styles/settings-overview.css#L955)
```css
.settings-overview-batch-icon-btn.icon-btn {
  min-width: var(--control-h-sm);
  width: var(--control-h-sm);
  min-height: var(--control-h-sm);
  height: var(--control-h-sm);
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
  --icon-glyph-size: 13px;
}
```

[settings-overview.css:966](../../apps/desktop/src/renderer/src/styles/settings-overview.css#L966)
```css
.settings-overview-batch-icon-btn.icon-btn:hover:not(:disabled),
.settings-overview-batch-icon-btn.icon-btn:focus-visible:not(:disabled) {
  border-color: transparent;
  background: color-mix(in srgb, var(--surface-control-hover) 78%, transparent);
  color: var(--text-primary);
}
```

[settings-overview.css:1001](../../apps/desktop/src/renderer/src/styles/settings-overview.css#L1001)
```css
.settings-overview-batch-icon-btn--danger.icon-btn:hover:not(:disabled),
.settings-overview-batch-icon-btn--danger.icon-btn:focus-visible:not(:disabled) {
  border-color: transparent;
  background: var(--surface-danger);
  color: color-mix(in srgb, var(--danger) 82%, var(--text-primary));
}
```

[workbench.css:88](../../apps/desktop/src/renderer/src/styles/workbench.css#L88)
```css
.workbench-tab {
  flex: 0 0 auto;
  min-height: var(--control-h-sm);
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--motion-fast),
    border-color var(--motion-fast),
    color var(--motion-fast);
}
```

[image-preview.css:15](../../apps/web/src/image-preview.css#L15)
```css
.image-preview .yarl__button {
  min-width: 48px;
  min-height: 48px;
  border: 1px solid transparent;
  border-radius: var(--radius);
}
```

[styles.css:91](../../apps/web/src/styles.css#L91)
```css
button.primary {
  background: var(--text-accent);
  color: var(--surface-base);
  border-color: transparent;
  font-weight: 650;
}
```

[styles.css:243](../../apps/web/src/styles.css#L243)
```css
.logout {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
}
```

[styles.css:358](../../apps/web/src/styles.css#L358)
```css
.sort-tabs button {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
  min-height: 40px;
  font-size: 13px;
}
```

[styles.css:711](../../apps/web/src/styles.css#L711)
```css
.resources .resource-heading { display: flex; flex: 1; min-width: 0; height: 64px; padding: 6px; gap: 8px; align-items: center; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: inherit; }
```

[styles.css:716](../../apps/web/src/styles.css#L716)
```css
.resource-actions button, .resource-actions a {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 48px; min-width: 48px; padding: 8px; border: 1px solid transparent;
  border-radius: var(--radius); background: transparent; color: var(--text-secondary); font-size: 13px;
}
```
