import { useState, type FormEvent } from 'react'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { post } from './client'
import PairLogin from './PairLogin'
import WebBrand from './WebBrand'
import { WebButton } from './WebButton'
import WebTextInput from './WebTextInput'
import { LoginField, RememberDevice, LoginCopy, LoginSubmitButton } from './LoginForm'
import styles from './Login.module.css'

type Session = { authenticated: boolean; username: string }

export default function Login({
  onLogin
}: {
  onLogin: (session: Session) => void
}): JSX.Element {
  const [mode, setMode] = useState<'pair' | 'password'>('pair')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onLogin(
        await post<Session>('/api/login', {
          username: data.get('username'),
          password: data.get('password'),
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
    <main className={styles.page} data-web-login>
      <section className={styles.card}>
        <WebBrand className={styles.brand} />
        <p className={styles.eyebrow}>YOUR LIBRARY, EVERY SCREEN</p>
        <h1>
          你的媒体库，
          <br />
          随处可看。
        </h1>
        <LoginCopy>登录以浏览这台电脑的媒体库。</LoginCopy>
        <div className={styles.tabs} data-login-tabs>
          <WebButton aria-pressed={mode === 'pair'} onClick={() => setMode('pair')}>与桌面配对</WebButton>
          <WebButton aria-pressed={mode === 'password'} onClick={() => setMode('password')}>密码登录</WebButton>
        </div>
        {mode === 'pair' ? <PairLogin onLogin={onLogin} /> : <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <LoginField>
            访问账号
            <WebTextInput
              appearance="login"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={64}
            />
          </LoginField>
          <LoginField>
            访问密码
            <WebTextInput
              appearance="login"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </LoginField>
          <RememberDevice checked={remember} onChange={e => setRemember(e.target.checked)}>记住此设备（长期有效）</RememberDevice>
          {error && (
            <LoginCopy role="alert" tone="danger">
              {error}
            </LoginCopy>
          )}
          <LoginSubmitButton disabled={busy}>
            {busy ? '正在登录…' : '进入媒体库'}
            <ChevronRight aria-hidden="true" />
          </LoginSubmitButton>
        </form>}
        <p className={styles.foot}>
          <ShieldCheck aria-hidden="true" />
          账号由桌面端设置 · 仅供浏览与播放
        </p>
      </section>
    </main>
  )
}
