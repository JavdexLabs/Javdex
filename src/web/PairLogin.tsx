import { useEffect, useState } from 'react'
import Checkbox from '../renderer/src/components/Checkbox'
import { post } from './client'

type Session = { authenticated: boolean; username: string }
export default function PairLogin({
  onLogin
}: {
  onLogin: (session: Session) => void
}): JSX.Element {
  const [remember, setRemember] = useState(false)
  const [name, setName] = useState('')
  const [pair, setPair] = useState<{ code: string; expires: number } | null>(
    null
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [remaining, setRemaining] = useState(0)
  useEffect(() => {
    if (!pair) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (Date.now() >= pair.expires) {
        setPair(null)
        setError('配对码已过期，请重新发起')
        return
      }
      try {
        const session = await post<Session>('/api/pair/poll')
        if (!alive) return
        if (session.authenticated) {
          onLogin(session)
          return
        }
        timer = setTimeout(() => void poll(), 5100)
      } catch (reason) {
        if (alive) {
          setPair(null)
          setError((reason as Error).message)
        }
      }
    }
    timer = setTimeout(() => void poll(), 5100)
    const tick = (): void =>
      setRemaining(Math.max(0, Math.ceil((pair.expires - Date.now()) / 1000)))
    tick()
    const clock = setInterval(tick, 1000)
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(clock)
    }
  }, [pair, onLogin])
  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setPair(
        await post('/api/pair/start', {
          name: name.trim() || '浏览器',
          remember
        })
      )
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pair-login">
      <p className="muted">
        在桌面「设置 → 网络 → 局域网 Web 访问」开启设备配对，再获取配对码。
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
            记住后重启应用仍可登录；闲置 24 小时或授权满 7
            天后失效。仅在自己的设备上使用。
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? '正在申请…' : '获取配对码'}
          </button>
        </>
      ) : (
        <div role="status">
          <p>在桌面输入此码，核对设备后批准</p>
          <strong className="pair-code">
            {pair.code.slice(0, 3)} {pair.code.slice(3)}
          </strong>
          <p className="muted">等待桌面批准 · 剩余 {remaining} 秒</p>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void post('/api/pair/cancel')
                .then(() => setPair(null))
                .catch((reason) => setError(reason.message))
                .finally(() => setBusy(false))
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
