import { useEffect, useRef } from 'preact/hooks'
import { coverUrl } from '../api'
import { lazyBackground } from '../lazy'
import { href } from '../router'
import { currentSong, playAll, playList, usePlayer } from '../player'
import { fmtTime } from '../hooks'
import { Icon } from './Icon'

// 封面统一用背景图 + padding 撑出正方形，旧 Safari 没有 aspect-ratio 和可靠的 object-fit。
// 列表里的封面默认懒加载；页面头部、播放栏这类必定可见的传 eager。
export function Cover({ id, size, round, eager }) {
  const url = coverUrl(id, size)
  const ref = useRef(null)
  useEffect(() => {
    if (!eager) lazyBackground(ref.current, url)
  }, [url, eager])
  return (
    <div class={'cover' + (round ? ' cover-round' : '')}>
      <div class="cover-img" ref={ref} style={eager && url ? { backgroundImage: `url("${url}")` } : null} />
    </div>
  )
}

export function Loading() {
  return <div class="state-msg">加载中…</div>
}

export function ErrorMsg({ error }) {
  return <div class="state-msg state-error">{(error && error.message) || '加载失败'}</div>
}

export function Empty({ text }) {
  return <div class="state-msg">{text}</div>
}

export function AlbumGrid({ albums }) {
  return (
    <div class="grid">
      {albums.map((a) => (
        <a class="grid-item" key={a.id} href={href('album', a.id)}>
          <Cover id={a.coverArt} size={300} />
          <div class="grid-title">{a.name}</div>
          <div class="grid-sub">{a.year ? a.artist + ' · ' + a.year : a.artist}</div>
        </a>
      ))}
    </div>
  )
}

export function TrackList({ songs, showCover }) {
  const player = usePlayer()
  const playingId = currentSong() ? currentSong().id : ''
  return (
    <ol class="tracks">
      {songs.map((s, i) => {
        const active = s.id === playingId
        return (
          <li key={s.id + '_' + i} class={'track' + (active ? ' track-active' : '')} onClick={() => playList(songs, i)}>
            <span class="track-no">
              {active && player.playing ? <span class="eq"><i /><i /><i /></span> : showCover ? null : s.track || i + 1}
              {showCover && !(active && player.playing) ? <Cover id={s.coverArt} size={64} /> : null}
            </span>
            <span class="track-main">
              <span class="track-title">{s.title}</span>
              <span class="track-sub">{showCover ? s.artist + ' · ' + s.album : s.artist}</span>
            </span>
            <span class="track-time">{fmtTime(s.duration)}</span>
          </li>
        )
      })}
    </ol>
  )
}

// 专辑、歌单页直接列出四种起播方式，循环和不循环各自可选，
// 不用先去播放器里把模式切对再回来点播放。
const PLAY_MODES = [
  { id: 'list', name: '顺序播放', icon: 'playlist' },
  { id: 'loop', name: '列表循环', icon: 'repeat' },
  { id: 'shuffle', name: '随机播放', icon: 'shuffleOnce' },
  { id: 'shuffleLoop', name: '随机循环', icon: 'shuffle' },
]

export function PlayButtons({ songs }) {
  const p = usePlayer()
  if (!songs || !songs.length) return null
  return (
    <div class="btn-row play-modes">
      {PLAY_MODES.map((m) => (
        <button
          key={m.id}
          class={'btn' + (p.mode === m.id ? ' is-on' : '')}
          onClick={() => playAll(songs, m.id)}
          title={m.name}
          aria-label={m.name}
        >
          <Icon name={m.icon} size={20} /> {m.name}
        </button>
      ))}
    </div>
  )
}
