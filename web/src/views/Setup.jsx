import { useState } from 'preact/hooks'
import { api, saveServer } from '../api'
import { Icon } from '../components/Icon'

function describe(server) {
  const name = server.type === 'navidrome' ? 'Navidrome' : server.type || 'Subsonic 服务'
  return name + (server.serverVersion ? ' ' + server.serverVersion.split(' ')[0] : '') + '（API ' + server.version + '）'
}

export function Setup({ url: initialUrl, onDone, onCancel }) {
  const [url, setUrl] = useState(initialUrl || '')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  // 保存前同样先测试连接，确认地址可用后才写入本浏览器。
  const run = (kind) => {
    if (busy) return
    setBusy(kind)
    setError('')
    setResult(null)
    api.testServer(url).then(
      (res) => {
        setBusy('')
        setUrl(res.url)
        setResult(res.server)
        if (kind === 'save') {
          saveServer(res.url)
          onDone(res.url)
        }
      },
      (err) => {
        setBusy('')
        setError(err.message)
      },
    )
  }

  const submit = (e) => {
    e.preventDefault()
    run('save')
  }

  return (
    <div class="login">
      <form class="login-card" onSubmit={submit} noValidate>
        <div class="login-logo">
          <Icon name="album" size={40} />
        </div>
        <h1 class="login-title">连接服务器</h1>
        <p class="login-desc">{initialUrl ? '更换 Navidrome 服务器地址' : '请先填写 Navidrome 的地址'}</p>
        <input
          class="input"
          type="url"
          autocapitalize="off"
          autocorrect="off"
          placeholder="例如 http://192.168.1.10:4533"
          value={url}
          onInput={(e) => {
            setUrl(e.target.value)
            setResult(null)
          }}
        />
        {result ? <div class="setup-ok">已连接：{describe(result)}</div> : null}
        {error ? <div class="login-error">{error}</div> : null}
        <div class="setup-actions">
          <button class="btn" type="button" disabled={!!busy || !url} onClick={() => run('test')}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button class="btn btn-primary" type="submit" disabled={!!busy || !url}>
            {busy === 'save' ? '保存中…' : '保存并继续'}
          </button>
        </div>
        <p class="setup-hint">地址只保存在当前浏览器，换浏览器或清除浏览器数据后需要重新填写。</p>
        {onCancel ? (
          <button class="btn btn-block setup-back" type="button" onClick={onCancel}>
            返回
          </button>
        ) : null}
      </form>
    </div>
  )
}
