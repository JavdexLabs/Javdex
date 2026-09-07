import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import type { LibraryPathRemovalPreview } from '@shared/libraryTypes'
import type {
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryRoot,
  MediaLibraryRootMigrationPreview,
  MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import ConfirmModal from '../components/ConfirmModal'
import { AppFormField } from '../components/FormPrimitives'
import SelectControl from '../components/SelectControl'
import styles from './MediaLibrarySettingsPage.module.css'

export type MediaLibrarySettingsBusyAction =
  | 'identity'
  | 'config'
  | 'add-root'
  | 'root-state'
  | 'remove-root'
  | 'cancel-root-removal'
  | 'migrate-root-preview'
  | 'migrate-root'
  | 'archive'
  | 'restore'
  | 'delete-preview'
  | 'delete'
  | null

export type RootRemovalState =
  | {
      kind: 'cleanup'
      root: MediaLibraryRoot
      preview: LibraryPathRemovalPreview
    }
  | {
      kind: 'direct'
      root: MediaLibraryRoot
      preview: LibraryPathRemovalPreview
    }

export interface RootMigrationState {
  root: MediaLibraryRoot
  targetLibraryId: number
  preview: MediaLibraryRootMigrationPreview | null
}

export function MediaLibrarySettingsDialogs({
  rootRemoval,
  setRootRemoval,
  rootMigration,
  setRootMigration,
  migrationTargets,
  lifecycleConfirm,
  setLifecycleConfirm,
  deleteConfirmOpen,
  setDeleteConfirmOpen,
  deletePreview,
  setDeletePreview,
  deleteConfirmation,
  setDeleteConfirmation,
  library,
  busy,
  confirmRootRemoval,
  confirmRootMigration,
  archiveLibrary,
  deleteLibrary
}: {
  rootRemoval: RootRemovalState | null
  setRootRemoval: Dispatch<SetStateAction<RootRemovalState | null>>
  rootMigration: RootMigrationState | null
  setRootMigration: Dispatch<SetStateAction<RootMigrationState | null>>
  migrationTargets: MediaLibrarySummary[]
  lifecycleConfirm: 'archive' | null
  setLifecycleConfirm: Dispatch<SetStateAction<'archive' | null>>
  deleteConfirmOpen: boolean
  setDeleteConfirmOpen: Dispatch<SetStateAction<boolean>>
  deletePreview: MediaLibraryDeletePreview | null
  setDeletePreview: Dispatch<SetStateAction<MediaLibraryDeletePreview | null>>
  deleteConfirmation: string
  setDeleteConfirmation: Dispatch<SetStateAction<string>>
  library: MediaLibraryDetail
  busy: MediaLibrarySettingsBusyAction
  confirmRootRemoval: () => Promise<void>
  confirmRootMigration: () => Promise<void>
  archiveLibrary: () => Promise<void>
  deleteLibrary: () => Promise<void>
}): JSX.Element {
  return (
    <>
      {rootRemoval ? (
        <ConfirmModal
          title={
            rootRemoval.kind === 'cleanup'
              ? '移除来源目录'
              : rootRemoval.root.state === 'disabled'
                ? '删除停用目录'
                : '删除来源目录'
          }
          confirmText={
            rootRemoval.kind === 'cleanup' ? '排队移除' : '删除目录记录'
          }
          danger
          busy={busy === 'remove-root'}
          onCancel={() => setRootRemoval(null)}
          onConfirm={() => void confirmRootRemoval()}
        >
          <div className={styles.confirmBody}>
            <p className={`${styles.confirmText} copyable-text`}>
              {rootRemoval.root.path}
            </p>
            {rootRemoval.kind === 'cleanup' ? (
              <>
                <p className={styles.confirmText}>
                  将在下一次安全扫描中清理该来源的资源记录；磁盘上的源文件不会被删除。
                </p>
                <dl className={styles.impactGrid}>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>本地资源</dt>
                    <dd className={styles.impactValue}>
                      {rootRemoval.preview.localResourceCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>STRM 资源</dt>
                    <dd className={styles.impactValue}>
                      {rootRemoval.preview.strmResourceCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>可能无资源的影片</dt>
                    <dd className={styles.impactValue}>
                      {rootRemoval.preview.videosBecomingResourceLess}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>待确认资源</dt>
                    <dd className={styles.impactValue}>
                      {rootRemoval.preview.pendingScanResourceCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>无法识别记录</dt>
                    <dd className={styles.impactValue}>
                      {rootRemoval.preview.unrecognizedFileCount}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <p className={styles.confirmText}>
                  该目录没有关联资源、待确认项或无法识别记录，将直接删除目录记录；
                  磁盘文件不会被删除。
                </p>
                {rootRemoval.preview.terminalCleanupJobCount > 0 ? (
                  <div className={styles.scanNotice} data-tone="warning">
                    同时会删除 {rootRemoval.preview.terminalCleanupJobCount}{' '}
                    条已完成、失败或取消的目录清理审计历史。
                  </div>
                ) : null}
              </>
            )}
          </div>
        </ConfirmModal>
      ) : null}

      {rootMigration ? (
        <ConfirmModal
          title="迁移来源目录"
          size="md"
          confirmText={rootMigration.preview ? '确认迁移' : '读取影响'}
          busy={busy === 'migrate-root-preview' || busy === 'migrate-root'}
          onCancel={() => setRootMigration(null)}
          onConfirm={() => void confirmRootMigration()}
        >
          <div className={styles.confirmBody}>
            <p className={`${styles.confirmText} copyable-text`}>
              {rootMigration.root.path}
            </p>
            <AppFormField
              label="目标媒体库"
              hint="只显示可写入的活动媒体库；源库和目标库有任务运行时会拒绝迁移。"
            >
              <SelectControl
                className={styles.migrationSelect}
                value={rootMigration.targetLibraryId}
                disabled={busy !== null}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setRootMigration((current) =>
                    current
                      ? {
                          ...current,
                          targetLibraryId: Number(event.target.value),
                          preview: null
                        }
                      : current
                  )
                }
              >
                {migrationTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </SelectControl>
            </AppFormField>

            {rootMigration.preview ? (
              <>
                <p className={styles.confirmText}>
                  将目录及其库内资源、待确认资源和未识别记录原子迁移到“
                  {rootMigration.preview.targetLibraryName}
                  ”。磁盘文件不会移动或删除，全局影片也不会删除。
                </p>
                <dl className={styles.impactGrid}>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>影片资源</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.resourceCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>涉及影片</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.videoCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>目标库新增成员</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.targetMembershipsToCreate}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>源库暂时无资源成员</dt>
                    <dd className={styles.impactValue}>
                      {
                        rootMigration.preview
                          .sourceMembershipsBecomingResourceLess
                      }
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>待确认资源</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.pendingScanResourceCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>待确认组</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.pendingScanGroupCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>合并到目标待确认组</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.targetPendingGroupsToMerge}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>未识别记录</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.unrecognizedFileCount}
                    </dd>
                  </div>
                  <div className={styles.impactItem}>
                    <dt className={styles.impactTerm}>源库主资源补位</dt>
                    <dd className={styles.impactValue}>
                      {rootMigration.preview.sourcePrimaryResourcesToPromote}
                    </dd>
                  </div>
                </dl>
                <div className={styles.migrationNotice} role="note">
                  {rootMigration.preview.sourceMembershipsBecomingResourceLess >
                  0
                    ? `迁移后源库有 ${rootMigration.preview.sourceMembershipsBecomingResourceLess} 个影片成员暂时没有资源；本次会保留这些成员关系，后续仅由源库的安全扫描清理策略决定是否移除。`
                    : '源库现有影片成员关系会保留；目标库已有主资源时，迁入资源会作为备用资源。'}
                </div>
              </>
            ) : (
              <div className={styles.migrationNotice} role="status">
                选择目标媒体库后读取影响。预览会固定源库与目标库的
                revision，任一侧随后发生变化都必须重新预览。
              </div>
            )}
          </div>
        </ConfirmModal>
      ) : null}

      {lifecycleConfirm === 'archive' ? (
        <ConfirmModal
          title="归档媒体库"
          confirmText="归档"
          busy={busy === 'archive'}
          onCancel={() => setLifecycleConfirm(null)}
          onConfirm={() => void archiveLibrary()}
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>
              归档“{library.name}
              ”后，自动扫描会暂停，并从侧栏隐藏；可在媒体库设置中恢复。
            </p>
            <p className={styles.confirmText}>
              影片元数据和来源目录不会被删除，稍后可以恢复。
            </p>
          </div>
        </ConfirmModal>
      ) : null}

      {deleteConfirmOpen && deletePreview ? (
        <ConfirmModal
          title="永久删除媒体库"
          confirmText="永久删除"
          danger
          busy={busy === 'delete'}
          confirmDisabled={
            deleteConfirmation.trim() !== deletePreview.name ||
            deletePreview.activeScanRunCount > 0 ||
            deletePreview.activeCleanupJobCount > 0
          }
          onCancel={() => {
            setDeleteConfirmOpen(false)
            setDeletePreview(null)
          }}
          onConfirm={() => void deleteLibrary()}
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>
              此操作无法撤销。请输入媒体库名称“{deletePreview.name}”继续。
            </p>
            <p className={styles.confirmText}>
              将删除该库的成员关系、资源记录、待确认项和扫描数据；本地与 STRM
              源文件仍保留。仅属于该库的 {deletePreview.exclusiveVideoCount}{' '}
              部影片资料会变为未归属，不会永久删除全局影片。
            </p>
            <dl className={styles.impactGrid}>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>来源目录</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.rootCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>影片成员</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.membershipCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>资源记录</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.resourceCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>仅属于该库的影片</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.exclusiveVideoCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>待确认资源</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.pendingScanResourceCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>待确认组</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.pendingScanGroupCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>扫描记录</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.scanRunCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>清理任务</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.cleanupJobCount}
                </dd>
              </div>
              <div className={styles.impactItem}>
                <dt className={styles.impactTerm}>未识别文件</dt>
                <dd className={styles.impactValue}>
                  {deletePreview.unrecognizedFileCount}
                </dd>
              </div>
            </dl>
            {deletePreview.activeScanRunCount > 0 ||
            deletePreview.activeCleanupJobCount > 0 ? (
              <div
                className={styles.scanNotice}
                data-tone="danger"
                role="alert"
              >
                当前仍有 {deletePreview.activeScanRunCount} 个扫描任务和{' '}
                {deletePreview.activeCleanupJobCount}{' '}
                个清理任务未结束，暂时不能删除。
              </div>
            ) : null}
            <input
              className={`text-input ${styles.textControl}`}
              autoFocus
              value={deleteConfirmation}
              aria-label="输入媒体库名称确认永久删除"
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
          </div>
        </ConfirmModal>
      ) : null}
    </>
  )
}
