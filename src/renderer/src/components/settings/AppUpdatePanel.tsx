import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { UpdateCheckErrorCode, UpdateCheckState } from '@shared/updateTypes'
import { api } from '../../api'
import { UI_ICON_SM } from '../iconDefaults'

const ERROR_LABELS: Record<UpdateCheckErrorCode, string> = {
  'network-unavailable': '无法连接更新服务器，请检查网络或代理设置',
  'rate-limited': 'GitHub 请求过于频繁，请稍后再试',
  'invalid-response': '更新服务器返回了无法识别的版本信息',
  'repository-unavailable': '暂时无法访问版本发布页',
  unknown: '检查更新失败，请稍后重试'
}

function formatCheckedAt(value?: string): string {
  if (!value) return '尚未检查'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '尚未检查'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function releaseSummary(notes: string): string {
  const line = notes
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*|^[-*]\s*/, '').trim())
    .find(Boolean)
  return line || '前往 GitHub 查看更新内容和下载文件。'
}

function hasReleaseNotes(notes: string): boolean {
  return notes.trim().length > 0
}

export default function AppUpdatePanel(): JSX.Element {
  const [state, setState] = useState<UpdateCheckState | null>(null)

  useEffect(() => {
    let active = true
    void api.appUpdate.getState().then((next) => {
      if (active) setState(next)
    })
    const unsubscribe = api.appUpdate.onStateChanged((next) => setState(next))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const checking = state?.status === 'checking'
  const available = state?.status === 'available'
  const ignored = Boolean(
    available && state?.latestRelease?.version === state?.ignoredVersion
  )
  const statusText = useMemo(() => {
    if (!state) return '正在读取版本信息…'
    if (checking) return '正在检查 GitHub Release…'
    if (available && state.latestRelease) {
      return ignored
        ? `版本 ${state.latestRelease.version} 已暂不提醒`
        : `发现新版本 ${state.latestRelease.version}`
    }
    if (state.status === 'up-to-date') return '当前已是最新版本'
    if (state.status === 'error' && state.errorCode) return ERROR_LABELS[state.errorCode]
    return '可手动检查 GitHub Release 中的最新版本'
  }, [available, checking, ignored, state])

  const runCheck = async (): Promise<void> => {
    setState(await api.appUpdate.check())
  }

  return (
    <section className="settings-overview-panel app-update-panel" aria-labelledby="app-update-title">
      <div className="settings-overview-panel-head app-update-panel-head">
        <div>
          <h3 id="app-update-title">版本更新</h3>
          <p>{statusText}</p>
        </div>
        <button type="button" className="btn btn-sm" disabled={checking} onClick={() => void runCheck()}>
          <RefreshCw {...UI_ICON_SM} className={checking ? 'is-spinning' : undefined} aria-hidden />
          {checking ? '检查中' : '检查更新'}
        </button>
      </div>

      <div className="app-update-meta">
        <span>当前版本 <strong>{state?.currentVersion ?? '—'}</strong></span>
        <span>上次检查 <strong>{formatCheckedAt(state?.checkedAt)}</strong></span>
      </div>

      {available && state?.latestRelease ? (
        <div className={`app-update-release${ignored ? ' is-ignored' : ''}`}>
          <div className="app-update-release-copy">
            <strong>{state.latestRelease.releaseName}</strong>
            <span className="selectable-text">{releaseSummary(state.latestRelease.releaseNotes)}</span>
          </div>
          <div className="app-update-actions">
            {!ignored ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void api.appUpdate.ignoreVersion(state.latestRelease!.version)}
              >
                暂不提醒
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              title="在浏览器中打开 GitHub Release 下载页面"
              onClick={() => void api.appUpdate.openRelease()}
            >
              前往下载
              <ExternalLink {...UI_ICON_SM} aria-hidden />
            </button>
          </div>
          {hasReleaseNotes(state.latestRelease.releaseNotes) ? (
            <details className="app-update-release-notes">
              <summary>查看 Release Log</summary>
              <div className="app-update-markdown selectable-text">
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => {
                          event.preventDefault()
                          if (href) void api.appUpdate.openExternalLink(href)
                        }}
                      >
                        {children}
                      </a>
                    )
                  }}
                >
                  {state.latestRelease.releaseNotes}
                </ReactMarkdown>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
