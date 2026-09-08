import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { WebAccessStatus } from '@shared/webTypes'
import { api } from '../../api'
import Button from '../Button'
import styles from './WebAccessPanel.module.css'

function AddressCode({ url }: { url: string }): JSX.Element {
  const [image, setImage] = useState('')
  useEffect(() => {
    let alive = true
    void QRCode.toDataURL(url, { width: 180, margin: 2 })
      .then((value) => {
        if (alive) setImage(value)
      })
      .catch(() => {
        if (alive) setImage('')
      })
    return () => {
      alive = false
    }
  }, [url])
  return (
    <div>
      {image && (
        <img
          src={image}
          width={180}
          height={180}
          alt={`扫码打开 ${url}，随后配对登录`}
        />
      )}
      <p className={styles.url}>{url}</p>
    </div>
  )
}
export default function WebDevices({
  status,
  onChange
}: {
  status: WebAccessStatus
  onChange: (value: WebAccessStatus) => void
}): JSX.Element {
  const [code, setCode] = useState('')
  const [candidate, setCandidate] = useState<{
    code: string
    name: string
    expires: number
    remember: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const urls = status.urls.filter((url) => !url.includes('127.0.0.1'))
  return (
    <section className={styles.status} aria-label="浏览器设备">
      <strong>设备配对</strong>
      {status.running && (
        <>
          <p>先开启配对，再在新设备网页获取六位码。仅允许你正在操作的设备。</p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onChange(await api.webAccess.pairOpen())
              })
            }
          >
            {status.pairingUntil > now
              ? `配对已开启 · 剩余 ${Math.min(300, Math.ceil((status.pairingUntil - now) / 1000))} 秒（延长）`
              : '开启配对（5 分钟）'}
          </Button>
          <div className={styles.address}>
            <label className={styles.field}>
              新设备显示的配对码
              <input
                className="text-input"
                value={code}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, ''))
                  setCandidate(null)
                }}
              />
            </label>
            <Button
              disabled={busy || code.length !== 6}
              onClick={() =>
                void run(async () => {
                  setCandidate({
                    ...(await api.webAccess.pairInspect(code)),
                    code
                  })
                })
              }
            >
              核对设备
            </Button>
          </div>
          {candidate && (
            <div>
              <p>{candidate.name}（设备名称由浏览器提供）</p>
              <p>
                配对码 {candidate.code} · 只读浏览与播放 ·{' '}
                {candidate.remember ? '记住此设备' : '临时登录'}
              </p>
              <div className={styles.actions}>
                <Button
                  disabled={busy || candidate.expires <= now}
                  onClick={() =>
                    void run(async () => {
                      onChange(
                        await api.webAccess.pairDecide(candidate.code, true)
                      )
                      setCandidate(null)
                      setCode('')
                    })
                  }
                >
                  批准登录
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      onChange(
                        await api.webAccess.pairDecide(candidate.code, false)
                      )
                      setCandidate(null)
                    })
                  }
                >
                  拒绝
                </Button>
              </div>
            </div>
          )}
          <details>
            <summary>手机扫码打开访问地址</summary>
            <p>连接同一局域网后扫码；二维码仅用于打开网页。</p>
            <div className={styles.address}>
              {urls.map((url) => (
                <AddressCode key={url} url={url} />
              ))}
            </div>
          </details>
        </>
      )}
      <strong>已登录设备</strong>
      <p>
        记住的设备跨应用重启保留，闲置 24 小时或授权满 7
        天后失效。撤销会断开当前 Web 连接，其他设备可重新连接。
      </p>
      {status.devices.length === 0 && <p>暂无有效设备，请在登录后刷新状态。</p>}
      {status.devices.map((device) => (
        <div key={device.id} className={styles.address}>
          <div className={styles.deviceCopy}>
            <strong>{device.name}</strong>
            <p>
              {device.remember ? '已记住' : '临时登录'} · 最近访问{' '}
              {new Date(device.touched).toLocaleString()}
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onChange(await api.webAccess.deviceRemove(device.id))
              })
            }
          >
            撤销
          </Button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
