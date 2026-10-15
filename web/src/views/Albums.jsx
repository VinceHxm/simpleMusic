import { useEffect, useState } from 'preact/hooks'
import { api } from '../api'
import { AlbumGrid, Empty, ErrorMsg, Loading } from '../components/common'

const TYPES = [
  ['newest', '最新'],
  ['recent', '最近播放'],
  ['frequent', '最常播放'],
  ['random', '随机'],
  ['starred', '收藏'],
  ['alphabeticalByName', '按名称'],
]
const PAGE = 40

// 从专辑详情返回时复用已加载的列表和滚动位置，不必在老设备上重新拉取和渲染。
const memo = { type: 'newest', albums: [], done: false, scrollY: 0 }

export function Albums() {
  const [type, setType] = useState(memo.type)
  const [albums, setAlbums] = useState(memo.albums)
  const [done, setDone] = useState(memo.done)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = (t, offset, base) => {
    setLoading(true)
    setError(null)
    api.albums(t, offset, PAGE).then(
      (res) => {
        const list = base.concat(res.albums)
        memo.albums = list
        memo.done = res.albums.length < PAGE
        setAlbums(list)
        setDone(memo.done)
        setLoading(false)
      },
      (err) => {
        setError(err)
        setLoading(false)
      },
    )
  }

  useEffect(() => {
    if (memo.albums.length) {
      const y = memo.scrollY
      setTimeout(() => window.scrollTo(0, y), 0)
    } else {
      load(type, 0, [])
    }
    const onScroll = () => {
      memo.scrollY = window.pageYOffset
    }
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const switchType = (t) => {
    if (t === type) return
    memo.type = t
    memo.albums = []
    setType(t)
    setAlbums([])
    setDone(false)
    load(t, 0, [])
  }

  return (
    <div class="page">
      <h2 class="page-title">专辑</h2>
      <div class="chips">
        {TYPES.map(([key, label]) => (
          <button key={key} class={'chip' + (key === type ? ' chip-on' : '')} onClick={() => switchType(key)}>
            {label}
          </button>
        ))}
      </div>
      {albums.length ? <AlbumGrid albums={albums} /> : null}
      {error ? <ErrorMsg error={error} /> : null}
      {loading ? <Loading /> : null}
      {!loading && !error && !albums.length ? <Empty text="这里还没有专辑" /> : null}
      {!loading && !done && albums.length > 0 && type !== 'random' ? (
        <div class="more">
          <button class="btn" onClick={() => load(type, albums.length, albums)}>
            加载更多
          </button>
        </div>
      ) : null}
      {type === 'random' && !loading ? (
        <div class="more">
          <button class="btn" onClick={() => load(type, 0, [])}>
            换一批
          </button>
        </div>
      ) : null}
    </div>
  )
}
