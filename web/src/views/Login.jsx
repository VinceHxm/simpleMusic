import { useState } from 'preact/hooks'
import { api } from '../api'
import { Icon } from '../components/Icon'

export function Login({ server, locked, onLogin, onChangeServer }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    api.login(server, username, password).then(
      () => onLogin(),
      (err) => {
        setError(err.message)
        setBusy(false)
      },
    )
  }

  return (
    <div class="login">
      <form class="login-card" onSubmit={submit}>
        <div class="login-logo">
          <Icon name="album" size={40} />
        </div>
        <h1 class="login-title">简单听</h1>
        <div class="login-sub">simpleMusic</div>
        <p class="login-desc">使用 Navidrome 账号登录</p>
        <div class="login-server">
          <span class="login-server-url">{server}</span>
          {locked ? null : (
            <a class="login-server-change" onClick={onChangeServer}>
              更换
            </a>
          )}
        </div>
        <input
          class="input"
          type="text"
          autocapitalize="off"
          autocorrect="off"
          placeholder="用户名"
          value={username}
          onInput={(e) => setUsername(e.target.value)}
        />
        <input class="input" type="password" placeholder="密码" value={password} onInput={(e) => setPassword(e.target.value)} />
        {error ? <div class="login-error">{error}</div> : null}
        <button class="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
