import { useEffect, useState } from 'react'
import Checkbox from '../renderer/src/components/Checkbox'
import type { WebPairState } from '../shared/webTypes'
import { ApiError, post } from './client'

type Session = { authenticated: boolean; username: string }
export default function PairLogin({
  onLogin
}: {
  onLogin: (session: Session) => void
}): JSX.Element {
  const [remember, setRemember] = useState(false)
  const [name, setName] = useState('')
  const [pair, setPair] = useState<WebPairState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [paused, setPaused] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (paused) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let request: AbortController | undefined
    let deadline = 0
    let delay = 5100
    const tick = (): void => {
      if (alive)
        setRemaining(
          Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
        )
    }
    const clock = setInterval(tick, 1000)
    const poll = async (restore = false): Promise<void> => {
      request = new AbortController()
      const timeout = setTimeout(() => request?.abort(), 15_000)
      try {
        const value = await post<WebPairState & Partial<Session>>(
          restore ? '/api/pair/status' : '/api/pair/poll',
          {},
          { signal: request.signal }
        )
        if (!alive) return
        setRestoring(false)
        setError('')
        delay = 5100
        if (value.authenticated) {
          onLogin(value as Session)
          return
        }
        setPair(value)
        deadline = performance.now() + value.remainingMs
        tick()
        timer = setTimeout(() => void poll(), delay)
      } catch (reason) {
        if (!alive) return
        setRestoring(false)
        if (
          reason instanceof ApiError &&
          [400, 401, 403, 410].includes(reason.status)
        ) {
          setPair(null)
          setError(restore && reason.status === 410 ? '' : reason.message)
          return
        }
        setError('连接暂时中断，正在自动重试…')
        timer = setTimeout(() => void poll(true), delay)
        delay = Math.min(delay * 2, 30_000)
      } finally {
        clearTimeout(timeout)
      }
    }
    void poll(true)
    return () => {
      alive = false
      request?.abort()
      clearTimeout(timer)
      clearInterval(clock)
    }
  }, [attempt, onLogin, paused])
  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setPair(
        await post<WebPairState>('/api/pair/start', {
          name: name.trim() || '浏览器',
          remember
        })
      )
      setAttempt((n) => n + 1)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pair-login">
      <p className="muted">
        在桌面「设置 → 网络 → 网页服务」开启设备配对，再获取配对码。
      </p>
      {!pair ? (
        <>
          <label>
            设备名称
            <input
              value={name}
              maxLength={50}
              placeholder="例如：客厅电视"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="remember-device">
            <Checkbox
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住此设备
          </label>
          <p className="muted">
            记住后长期有效，退出登录、撤销授权或修改密码后失效。仅在自己的设备上使用。
          </p>
          <button
            className="primary"
            disabled={busy || restoring}
            onClick={() => void start()}
          >
            {restoring ? '正在恢复配对…' : busy ? '正在申请…' : '获取配对码'}
          </button>
        </>
      ) : (
        <div>
          <p>在桌面输入此码，核对设备后批准</p>
          <strong className="pair-code">
            {pair.code.slice(0, 3)} {pair.code.slice(3)}
          </strong>
          <p className="muted" role="status">
            {pair.state === 'approved' ? '已批准，正在连接' : remaining === 0 ? '配对码已过期' : '等待桌面批准'}
          </p>
          <p className="muted">
            剩余 {remaining} 秒
          </p>
          <button
            disabled={busy || restoring}
            onClick={() => {
              setBusy(true)
              setPaused(true)
              void post('/api/pair/cancel')
                .then(() => {
                  setPair(null)
                  setAttempt((n) => n + 1)
                })
                .catch((reason) => setError(reason.message))
                .finally(() => {
                  setBusy(false)
                  setPaused(false)
                })
            }}
          >
            取消配对
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  )
}
