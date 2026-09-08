import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { WebAccessStatus } from '@shared/webTypes'
import { api } from '../../api'
import Button from '../Button'
import ConfirmModal from '../ConfirmModal'
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
  const [confirm, setConfirm] = useState<{
    kind: 'revoke' | 'rename' | 'reset' | 'all'
    id?: string
    name?: string
  } | null>(null)
  const [newName, setNewName] = useState('')
  const lock = useRef(false)
  const revision = useRef(0)
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
    if (lock.current) return
    lock.current = true
    revision.current++
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      const current = revision.current
      if (!lock.current) {
        try {
          const next = await api.webAccess.status()
          if (alive && !lock.current && current === revision.current)
            onChange(next)
        } catch {
          /* Keep the last snapshot; the next poll retries. */
        }
      }
      if (alive) timer = setTimeout(() => void refresh(), 2000)
    }
    timer = setTimeout(() => void refresh(), 2000)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [onChange])
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
      {status.pairingActivity.map((item) => (
        <p key={item.code} role="status">
          {item.name} · {item.code} ·{' '}
          {item.state === 'connected' ? '已连接' : '已批准，等待连接'}
        </p>
      ))}
      <strong>已登录设备</strong>
      <p>
        记住的设备跨应用重启保留，闲置 24 小时或授权满 7
        天后失效。撤销只会断开该设备的连接。
      </p>
      {status.devices.length === 0 && <p>暂无有效设备，登录后会自动更新。</p>}
      {status.devices.map((device) => (
        <div key={device.id} className={styles.address}>
          <div className={styles.deviceCopy}>
            <strong>{device.name}</strong>
            <p>
              {device.remember ? '已记住' : '临时登录'} · 最近访问{' '}
              {new Date(device.touched).toLocaleString()}
              <br />
              到期时间 {new Date(device.expires).toLocaleString()}
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() => {
              setNewName(device.name)
              setConfirm({ kind: 'rename', id: device.id, name: device.name })
            }}
          >
            重命名
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setError('')
              setConfirm({ kind: 'revoke', id: device.id, name: device.name })
            }}
          >
            撤销
          </Button>
        </div>
      ))}
      <div className={styles.actions}>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setError('')
            setConfirm({ kind: 'all' })
          }}
        >
          退出所有浏览器会话
        </Button>
        {status.error && !status.running && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setError('')
              setConfirm({ kind: 'reset' })
            }}
          >
            重置浏览器授权
          </Button>
        )}
      </div>
      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === 'rename'
              ? '重命名设备'
              : confirm.kind === 'reset'
                ? '重置浏览器授权'
                : confirm.kind === 'all'
                  ? '退出所有浏览器会话'
                  : '撤销设备授权'
          }
          danger={confirm.kind !== 'rename'}
          busy={busy}
          closeDisabled={busy}
          confirmText={confirm.kind === 'rename' ? '保存' : '确认'}
          confirmDisabled={confirm.kind === 'rename' && !newName.trim()}
          onCancel={() => {
            if (!lock.current) setConfirm(null)
          }}
          onConfirm={() =>
            void run(async () => {
              const next =
                confirm.kind === 'rename'
                  ? await api.webAccess.deviceRename(
                      confirm.id!,
                      newName.trim()
                    )
                  : confirm.kind === 'revoke'
                    ? await api.webAccess.deviceRemove(confirm.id!)
                    : confirm.kind === 'reset'
                      ? await api.webAccess.deviceReset()
                      : await api.webAccess.revoke()
              onChange(next)
              setConfirm(null)
            })
          }
        >
          {confirm.kind === 'rename' ? (
            <label className={styles.field}>
              设备名称
              <input
                className="text-input"
                value={newName}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
          ) : (
            <p>
              {confirm.kind === 'revoke'
                ? `将退出“${confirm.name}”并停止它的播放。其他设备不受影响。`
                : '所有浏览器需要重新登录或配对，当前播放连接会关闭。账号、密码和媒体库保持不变。'}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </ConfirmModal>
      )}
      {!confirm && error && <p role="alert">{error}</p>}
    </section>
  )
}
