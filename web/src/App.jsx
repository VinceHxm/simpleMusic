import { useEffect, useState } from 'preact/hooks'
import { api, saveServer, savedServer, setUnauthorizedHandler } from './api'
import { Icon } from './components/Icon'
import { FullPlayer, PlayerBar } from './components/Player'
import { reset, restore, usePlayer } from './player'
import { href, useRoute } from './router'
import { Albums } from './views/Albums'
import { Album, Artist, Playlist } from './views/Detail'
import { Artists, Playlists, Search } from './views/Lists'
import { Login } from './views/Login'
import { Setup } from './views/Setup'

const NAV = [
  ['albums', '专辑', 'album'],
  ['artists', '艺人', 'artist'],
  ['playlists', '歌单', 'queue'],
  ['search', '搜索', 'search'],
]

const ACTIVE_TAB = { album: 'albums', artist: 'artists', playlist: 'playlists' }

function View({ route }) {
  switch (route.name) {
    case 'album':
      return <Album id={route.id} />
    case 'artist':
      return <Artist id={route.id} />
    case 'artists':
      return <Artists />
    case 'playlist':
      return <Playlist id={route.id} />
    case 'playlists':
      return <Playlists />
    case 'search':
      return <Search />
    default:
      return <Albums />
  }
}

// 启动顺序：本浏览器没记过服务器地址 → 连接服务器页；记过但未登录 → 登录页；否则进入主界面。
// 启动参数锁定了地址时以服务端为准，不读本地记录。
export function App() {
  const [phase, setPhase] = useState('boot')
  const [status, setStatus] = useState(null)
  const [user, setUser] = useState(null)
  const [bootError, setBootError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const route = useRoute()
  const player = usePlayer()

  const boot = () => {
    setBootError('')
    api.setup().then(
      (st) => {
        const url = st.locked ? st.url : savedServer()
        setStatus({ locked: st.locked, url })
        api.me().then(
          (me) => {
            if (!st.locked && url && me.server !== url) {
              // 会话属于另一台服务器（例如本地记录被改过），作废后重新登录。
              api.logout().then(
                () => {
                  reset()
                  setUser(null)
                  setPhase('login')
                },
                () => setPhase('login'),
              )
              return
            }
            // 升级前地址存在服务端，已登录的浏览器沿用会话里的地址，不必重新填写。
            if (!st.locked && !url) {
              saveServer(me.server)
              setStatus({ locked: false, url: me.server })
            }
            restore()
            setUser(me)
            setPhase('app')
          },
          () => {
            setUser(null)
            setPhase(url ? 'login' : 'setup')
          },
        )
      },
      (err) => {
        setBootError(err.message)
        setPhase('boot')
      },
    )
  }

  useEffect(() => {
    setUnauthorizedHandler(boot)
    boot()
  }, [])

  useEffect(() => {
    document.documentElement.className = expanded ? 'no-scroll' : ''
  }, [expanded])

  const openSetup = () => setPhase('setup')

  if (phase === 'boot')
    return bootError ? (
      <div class="login">
        <div class="login-card">
          <div class="login-error">{bootError}</div>
          <button class="btn btn-primary btn-block" onClick={boot}>
            重试
          </button>
        </div>
      </div>
    ) : (
      <div class="boot" />
    )

  if (phase === 'setup')
    return (
      <Setup
        url={status.url}
        onDone={(url) => {
          if (url === status.url) {
            boot()
            return
          }
          // 换了服务器：旧会话和播放队列都属于原服务器，一并清掉。
          const done = () => {
            reset()
            setUser(null)
            boot()
          }
          api.logout().then(done, done)
        }}
        onCancel={status.url ? () => setPhase(user ? 'app' : 'login') : null}
      />
    )

  if (phase === 'login') return <Login server={status.url} locked={status.locked} onLogin={boot} onChangeServer={openSetup} />

  const logout = () => {
    api.logout().then(() => {
      reset()
      setUser(null)
      boot()
    })
  }

  const tab = ACTIVE_TAB[route.name] || route.name
  const hasPlayer = player.queue.length > 0

  return (
    <div class={'app' + (hasPlayer ? ' has-player' : '')}>
      <nav class="nav">
        <div class="brand hide-mobile">
          <Icon name="album" size={30} />
          <span class="brand-text">
            <span class="brand-name">简单听</span>
            <span class="brand-sub">simpleMusic</span>
          </span>
        </div>
        {NAV.map(([key, label, icon]) => (
          <a key={key} class={'nav-item' + (tab === key ? ' nav-on' : '')} href={href(key)}>
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </a>
        ))}
        <div class="nav-user hide-mobile">
          <span class="nav-user-name">{user.username}</span>
          {!status.locked ? (
            <button class="icon-btn" onClick={openSetup} aria-label="服务器设置">
              <Icon name="server" size={20} />
            </button>
          ) : null}
          <button class="icon-btn" onClick={logout} aria-label="退出登录">
            <Icon name="logout" size={20} />
          </button>
        </div>
      </nav>
      <main class="main">
        <View route={route} />
        <div class="mobile-footer hide-desktop">
          {user.username} · {!status.locked ? <a onClick={openSetup}>服务器设置</a> : null}
          {!status.locked ? ' · ' : null}
          <a onClick={logout}>退出登录</a>
        </div>
      </main>
      <PlayerBar onExpand={() => setExpanded(true)} />
      {expanded ? <FullPlayer onClose={() => setExpanded(false)} /> : null}
    </div>
  )
}
