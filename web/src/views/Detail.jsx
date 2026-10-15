import { useEffect, useState } from 'preact/hooks'
import { api, blurUrl } from '../api'
import { AlbumGrid, Cover, Empty, ErrorMsg, Loading, PlayButtons, TrackList } from '../components/common'
import { Icon } from '../components/Icon'
import { fmtTotal, useAsync } from '../hooks'
import { href } from '../router'

function Hero({ coverArt, round, kind, title, children }) {
  const bg = blurUrl(coverArt)
  return (
    <div class="hero">
      <div class="hero-bg" style={bg ? { backgroundImage: `url("${bg}")` } : null} />
      <div class="hero-inner">
        <div class="hero-cover">
          <Cover id={coverArt} size={300} round={round} eager />
        </div>
        <div class="hero-info">
          <div class="hero-kind">{kind}</div>
          <h2 class="hero-title">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  )
}

function StarButton({ id, kind, starred }) {
  const [on, setOn] = useState(!!starred)
  useEffect(() => setOn(!!starred), [id, starred])
  const flip = () => {
    const next = !on
    setOn(next)
    api.star(id, kind, next).catch(() => setOn(!next))
  }
  return (
    <button class={'btn btn-icon' + (on ? ' is-on' : '')} onClick={flip} aria-label={on ? '取消收藏' : '收藏'}>
      <Icon name={on ? 'heart' : 'heartOutline'} size={20} />
    </button>
  )
}

export function Album({ id }) {
  const { data, error, loading } = useAsync(() => api.album(id), [id])
  if (loading) return <Loading />
  if (error) return <ErrorMsg error={error} />
  const songs = data.song || []
  return (
    <div>
      <Hero coverArt={data.coverArt} kind="专辑" title={data.name}>
        <div class="hero-sub">
          {data.artistId ? <a href={href('artist', data.artistId)}>{data.artist}</a> : data.artist}
        </div>
        <div class="hero-meta">
          {[data.year, songs.length + ' 首', fmtTotal(data.duration)].filter(Boolean).join(' · ')}
        </div>
        <div class="hero-actions">
          <PlayButtons songs={songs} />
          <StarButton id={data.id} kind="album" starred={data.starred} />
        </div>
      </Hero>
      <div class="page">
        <TrackList songs={songs} />
      </div>
    </div>
  )
}

export function Artist({ id }) {
  const { data, error, loading } = useAsync(() => api.artist(id), [id])
  if (loading) return <Loading />
  if (error) return <ErrorMsg error={error} />
  const albums = data.album || []
  return (
    <div>
      <Hero coverArt={data.coverArt} round kind="艺人" title={data.name}>
        <div class="hero-meta">{albums.length} 张专辑</div>
        <div class="hero-actions">
          <StarButton id={data.id} kind="artist" starred={data.starred} />
        </div>
      </Hero>
      <div class="page">{albums.length ? <AlbumGrid albums={albums} /> : <Empty text="没有专辑" />}</div>
    </div>
  )
}

export function Playlist({ id }) {
  const { data, error, loading } = useAsync(() => api.playlist(id), [id])
  if (loading) return <Loading />
  if (error) return <ErrorMsg error={error} />
  const songs = data.entry || []
  return (
    <div>
      <Hero coverArt={data.coverArt} kind="歌单" title={data.name}>
        {data.comment ? <div class="hero-sub">{data.comment}</div> : null}
        <div class="hero-meta">{songs.length + ' 首 · ' + fmtTotal(data.duration)}</div>
        <div class="hero-actions">
          <PlayButtons songs={songs} />
        </div>
      </Hero>
      <div class="page">{songs.length ? <TrackList songs={songs} showCover /> : <Empty text="歌单是空的" />}</div>
    </div>
  )
}
