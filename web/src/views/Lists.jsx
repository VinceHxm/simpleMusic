import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../api'
import { AlbumGrid, Cover, Empty, ErrorMsg, Loading, TrackList } from '../components/common'
import { Icon } from '../components/Icon'
import { useAsync } from '../hooks'
import { playList } from '../player'
import { href } from '../router'

function ArtistRows({ artists }) {
  return (
    <div class="rows">
      {artists.map((a) => (
        <a class="row" key={a.id} href={href('artist', a.id)}>
          <span class="row-cover">
            <Cover id={a.coverArt} size={64} round />
          </span>
          <span class="row-main">
            <span class="row-title">{a.name}</span>
            <span class="row-sub">{a.albumCount || 0} 张专辑</span>
          </span>
        </a>
      ))}
    </div>
  )
}

export function Artists() {
  const { data, error, loading } = useAsync(() => api.artists(), [])
  if (loading) return <Loading />
  if (error) return <ErrorMsg error={error} />
  return (
    <div class="page">
      <h2 class="page-title">艺人</h2>
      {data.indexes.length ? null : <Empty text="还没有艺人" />}
      {data.indexes.map((idx) => (
        <div key={idx.name} class="index-group">
          <div class="index-letter">{idx.name}</div>
          <ArtistRows artists={idx.artist} />
        </div>
      ))}
    </div>
  )
}

export function Playlists() {
  const { data, error, loading } = useAsync(() => api.playlists(), [])
  const [busy, setBusy] = useState(false)
  if (loading) return <Loading />
  if (error) return <ErrorMsg error={error} />

  const randomPlay = () => {
    setBusy(true)
    api.random(100).then(
      (res) => {
        setBusy(false)
        playList(res.songs, 0)
      },
      () => setBusy(false),
    )
  }

  return (
    <div class="page">
      <h2 class="page-title">歌单</h2>
      <div class="rows">
        <div class="row" onClick={randomPlay}>
          <span class="row-cover row-cover-icon">
            <Icon name="shuffle" />
          </span>
          <span class="row-main">
            <span class="row-title">随机漫游</span>
            <span class="row-sub">{busy ? '正在挑歌…' : '从整个曲库随机挑 100 首'}</span>
          </span>
        </div>
        {data.playlists.map((p) => (
          <a class="row" key={p.id} href={href('playlist', p.id)}>
            <span class="row-cover">
              <Cover id={p.coverArt} size={64} />
            </span>
            <span class="row-main">
              <span class="row-title">{p.name}</span>
              <span class="row-sub">{p.songCount} 首</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  )
}

const searchMemo = { q: '', result: null }

export function Search() {
  const [q, setQ] = useState(searchMemo.q)
  const [result, setResult] = useState(searchMemo.result)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(0)
  const seq = useRef(0)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onInput = (e) => {
    const value = e.target.value
    setQ(value)
    searchMemo.q = value
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const id = ++seq.current
      if (!value.trim()) {
        searchMemo.result = null
        setResult(null)
        return
      }
      setLoading(true)
      api.search(value).then(
        (res) => {
          if (id !== seq.current) return
          searchMemo.result = res
          setResult(res)
          setError(null)
          setLoading(false)
        },
        (err) => {
          if (id !== seq.current) return
          setError(err)
          setLoading(false)
        },
      )
    }, 350)
  }

  const empty = result && !result.artist.length && !result.album.length && !result.song.length

  return (
    <div class="page">
      <h2 class="page-title">搜索</h2>
      <div class="search-box">
        <Icon name="search" size={20} />
        <input class="search-input" type="search" placeholder="歌曲、专辑、艺人" value={q} onInput={onInput} autofocus />
      </div>
      {loading ? <Loading /> : null}
      {error ? <ErrorMsg error={error} /> : null}
      {empty ? <Empty text="没有找到相关内容" /> : null}
      {result && result.artist.length ? (
        <section class="section">
          <h3 class="section-title">艺人</h3>
          <ArtistRows artists={result.artist} />
        </section>
      ) : null}
      {result && result.album.length ? (
        <section class="section">
          <h3 class="section-title">专辑</h3>
          <AlbumGrid albums={result.album} />
        </section>
      ) : null}
      {result && result.song.length ? (
        <section class="section">
          <h3 class="section-title">歌曲</h3>
          <TrackList songs={result.song} showCover />
        </section>
      ) : null}
    </div>
  )
}
