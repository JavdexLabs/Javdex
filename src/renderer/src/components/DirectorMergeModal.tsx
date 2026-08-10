import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Clapperboard, SearchX } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type {
  DirectorDetail,
  DirectorMergeResult,
  DirectorOption
} from '@shared/classificationTypes'
import { api } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { directorKeys } from '../query/queryKeys'
import EmptyState from './EmptyState'
import Modal from './Modal'
import { UI_ICON_SM } from './iconDefaults'
import {
  buildDirectorMergeInput,
  reconcileDirectorMergeSource
} from './directorMergeState'

interface Props {
  target: DirectorDetail
  onCancel: () => void
  onMerged: (result: DirectorMergeResult) => void | Promise<void>
}

function directorMeta(director: DirectorOption): string {
  const details = [
    director.countryRegion,
    director.birthDate ? `出生 ${director.birthDate}` : null,
    director.careerStartYear || director.careerEndYear
      ? `从业 ${director.careerStartYear ?? '未知'} - ${director.careerEndYear ?? '至今'}`
      : null
  ].filter(Boolean)
  details.push(`档案 #${director.id}`)
  return details.join(' · ')
}

export default function DirectorMergeModal({ target, onCancel, onMerged }: Props): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounce(searchInput, 300).trim()
  const [selected, setSelected] = useState<DirectorOption | null>(null)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidatesQuery = useQuery({
    queryKey: directorKeys.options(search),
    queryFn: () => api.directors.options(search)
  })
  const candidates = useMemo(
    () => (candidatesQuery.data ?? []).filter((candidate) => candidate.id !== target.id),
    [candidatesQuery.data, target.id]
  )

  useEffect(() => {
    setSelected((current) => reconcileDirectorMergeSource(current, candidates))
  }, [candidates])

  const input = buildDirectorMergeInput(target.id, selected?.id ?? null)
  const merge = async (): Promise<void> => {
    if (!input || merging) return
    setMerging(true)
    setError(null)
    try {
      const result = await api.directors.merge(input)
      await onMerged(result)
    } catch (mergeError) {
      setError(String((mergeError as Error).message))
    } finally {
      setMerging(false)
    }
  }

  return (
    <Modal
      title="合并导演"
      hint="当前导演固定为保留目标。选择另一位导演并入后，来源记录会被删除。"
      size="md"
      className="director-merge-modal"
      confirmText={merging ? '合并中…' : '确认合并'}
      confirmDisabled={!input}
      busy={merging}
      danger
      onCancel={onCancel}
      onConfirm={() => void merge()}
    >
      <div className="director-merge-body">
        <div className="director-merge-flow" aria-label="导演合并方向">
          <article
            className={`director-merge-card${selected ? ' director-merge-card--source' : ''}`}
          >
            <span className="director-merge-badge">来源 · 并入后删除</span>
            <Clapperboard {...UI_ICON_SM} aria-hidden />
            <strong>{selected?.mainName ?? '尚未选择来源'}</strong>
            <small>
              {selected
                ? `档案 #${selected.id} · ${selected.videoCount} 部影片 · 主名转为目标别名`
                : '从下方候选中选择一位导演'}
            </small>
          </article>
          <ArrowRight className="director-merge-arrow" {...UI_ICON_SM} aria-hidden />
          <article className="director-merge-card director-merge-card--target">
            <span className="director-merge-badge">目标 · 保留</span>
            <Clapperboard {...UI_ICON_SM} aria-hidden />
            <strong>{target.mainName}</strong>
            <small>档案 #{target.id} · {target.videoCount} 部影片 · 主名保持不变</small>
          </article>
        </div>

        <section className="director-merge-picker" aria-label="选择来源导演">
          <div className="director-merge-section-head">
            <strong>选择来源导演</strong>
            {!candidatesQuery.isLoading && candidates.length > 0 ? (
              <span>{candidates.length} 位候选</span>
            ) : null}
          </div>
          <input
            className="search-input"
            type="search"
            placeholder="搜索主名或别名…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            autoFocus
          />
          <div className="director-merge-candidates">
            {candidatesQuery.isLoading ? (
              <EmptyState loading variant="modal" />
            ) : candidatesQuery.isError ? (
              <EmptyState
                variant="modal"
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title="候选导演加载失败"
                description={String(candidatesQuery.error)}
              />
            ) : candidates.length === 0 ? (
              <EmptyState
                variant="modal"
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title={search ? '没有匹配的导演' : '没有可合并的导演'}
                description={search ? '调整搜索关键词后再试。' : '当前没有其他导演资料。'}
              />
            ) : (
              <div role="listbox" aria-label="来源导演候选">
                {candidates.map((candidate) => {
                  const isSelected = candidate.id === selected?.id
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={`director-merge-candidate${isSelected ? ' is-selected' : ''}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => setSelected(candidate)}
                    >
                      <span className="director-merge-radio" aria-hidden />
                      <span className="director-merge-candidate-main">
                        <strong>{candidate.mainName}</strong>
                        <small>{directorMeta(candidate)}</small>
                      </span>
                      <span>{candidate.videoCount} 部</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        {selected ? (
          <section className="director-merge-plan" aria-label="合并规则">
            <strong>合并后</strong>
            <ul>
              <li>保留“{target.mainName}”作为主名，“{selected.mainName}”转为别名</li>
              <li>别名与相关链接去重合并，目标已有资料优先</li>
              <li>目标空字段由来源补齐，全部来源影片转移到目标</li>
              <li>目标没有正式肖像时才接收来源肖像</li>
            </ul>
          </section>
        ) : null}
        {error ? <p className="director-merge-error">{error}</p> : null}
      </div>
    </Modal>
  )
}
