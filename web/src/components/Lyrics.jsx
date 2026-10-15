import { useEffect, useMemo, useRef } from 'preact/hooks'
import { api } from '../api'
import { useAsync } from '../hooks'
import { seekTo, useProgress } from '../player'

// 用户手动滑动歌词后，暂停自动跟随这么久。
const HOLD_MS = 3000
// 提前一点切到下一行，抵消渲染和滚动动画的延迟。
const LEAD_MS = 200

function activeIndex(lines, ms) {
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time > ms) break
    found = i
  }
  return found
}

// 旧 Safari 不支持 scrollTo 的 smooth 选项，用 requestAnimationFrame 自己做缓动。
function animateScroll(box, to, state) {
  if (state.raf) cancelAnimationFrame(state.raf)
  const from = box.scrollTop
  const delta = to - from
  if (Math.abs(delta) < 2) return
  const start = Date.now()
  const step = () => {
    const t = Math.min((Date.now() - start) / 300, 1)
    box.scrollTop = from + delta * (1 - Math.pow(1 - t, 3))
    state.raf = t < 1 ? requestAnimationFrame(step) : 0
  }
  state.raf = requestAnimationFrame(step)
}

function LineText({ line }) {
  return [
    line.text || '♪',
    line.trans ? <span class="lyrics-trans">{line.trans}</span> : null,
  ]
}

function SyncedLyrics({ lines }) {
  const p = useProgress()
  const box = useRef(null)
  const scroll = useRef({ raf: 0, holdUntil: 0, first: true })
  const active = activeIndex(lines, p.current * 1000 + LEAD_MS)

  useEffect(() => {
    const s = scroll.current
    const el = box.current
    if (!el || Date.now() < s.holdUntil) return
    const row = el.querySelector('.lyrics-active') || el.querySelector('.lyrics-line')
    if (!row) return
    const to = row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2
    if (s.first) {
      el.scrollTop = to
      s.first = false
    } else {
      animateScroll(el, to, s)
    }
  }, [active])

  useEffect(() => () => cancelAnimationFrame(scroll.current.raf), [])

  const hold = () => {
    const s = scroll.current
    if (s.raf) cancelAnimationFrame(s.raf)
    s.raf = 0
    s.holdUntil = Date.now() + HOLD_MS
  }

  // 播放进度每秒刷新多次，只有当前行变化时才重新生成列表，减轻老设备的渲染压力。
  const list = useMemo(
    () => (
      <ol class="lyrics-list">
        {lines.map((line, i) => (
          <li
            key={i}
            class={'lyrics-line' + (i === active ? ' lyrics-active' : '')}
            onClick={() => {
              scroll.current.holdUntil = 0
              seekTo(line.time / 1000)
            }}
          >
            <LineText line={line} />
          </li>
        ))}
      </ol>
    ),
    [lines, active],
  )

  return (
    <div class="lyrics" ref={box} onTouchStart={hold} onWheel={hold} onMouseDown={hold}>
      {list}
    </div>
  )
}

function PlainLyrics({ lines }) {
  return (
    <div class="lyrics lyrics-plain">
      <ol class="lyrics-list">
        {lines.map((line, i) => (
          <li key={i} class="lyrics-line">
            <LineText line={line} />
          </li>
        ))}
      </ol>
    </div>
  )
}

export function Lyrics({ song }) {
  const { data, loading } = useAsync(() => api.lyrics(song), [song.id])
  if (loading) return <div class="lyrics lyrics-msg">正在加载歌词…</div>
  if (!data || !data.lines || !data.lines.length) return <div class="lyrics lyrics-msg">暂无歌词</div>
  return data.synced ? <SyncedLyrics key={song.id} lines={data.lines} /> : <PlainLyrics lines={data.lines} />
}
