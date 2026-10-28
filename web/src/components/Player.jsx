import { useEffect, useRef, useState } from 'preact/hooks'
import { blurUrl, coverUrl } from '../api'
import { fmtTime } from '../hooks'
import { href } from '../router'
import { lockLyricsOn, lockLyricsSupported, setLockLyrics } from '../lockLyrics'
import { MODES, currentSong, cycleMode, next, playAt, prev, queueView, seek, toggle, usePlayer, useProgress } from '../player'
import { Cover } from './common'
import { Icon } from './Icon'
import { Lyrics } from './Lyrics'

const LYRICS_KEY = 'sm_lyrics'

function loadLyricsPref() {
  try {
    return window.localStorage.getItem(LYRICS_KEY) === '1'
  } catch (e) {
    return false
  }
}

function saveLyricsPref(on) {
  try {
    window.localStorage.setItem(LYRICS_KEY, on ? '1' : '0')
  } catch (e) {}
}

const COVER_KEY = 'sm_cover'

function loadCoverPref() {
  try {
    const v = JSON.parse(window.localStorage.getItem(COVER_KEY) || 'null')
    if (v) return { round: !!v.round, anim: v.anim !== undefined ? !!v.anim : v.spin !== undefined ? !!v.spin : true }
  } catch (e) {}
  return { round: false, anim: true }
}

function saveCoverPref(pref) {
  try {
    window.localStorage.setItem(COVER_KEY, JSON.stringify(pref))
  } catch (e) {}
}

function CoverMenu({ pref, onChange, onClose }) {
  const [lockLyrics, setLockLyricsOn] = useState(lockLyricsOn)
  return (
    <div>
      <div class="cover-menu-mask" onClick={onClose} />
      <div class="cover-menu">
        <div class="cover-menu-label">封面形状</div>
        <div class="seg">
          <button class={'seg-item' + (!pref.round ? ' seg-on' : '')} onClick={() => onChange({ round: false, anim: pref.anim })}>
            方形
          </button>
          <button class={'seg-item' + (pref.round ? ' seg-on' : '')} onClick={() => onChange({ round: true, anim: pref.anim })}>
            圆形
          </button>
        </div>
        {pref.round ? (
          <div class="cover-menu-row" role="button" onClick={() => onChange({ round: true, anim: !pref.anim })}>
            <span>动画效果</span>
            <span class={'switch' + (pref.anim ? ' switch-on' : '')} />
          </div>
        ) : null}
        {lockLyricsSupported ? (
          <div
            class="cover-menu-row"
            role="button"
            onClick={() => {
              setLockLyrics(!lockLyrics)
              setLockLyricsOn(!lockLyrics)
            }}
          >
            <span>锁屏显示歌词</span>
            <span class={'switch' + (lockLyrics ? ' switch-on' : '')} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

// 唱臂角度（顺时针，单位度）：抬起时停在唱片外；落下后随播放进度从外圈移到内圈。
// -6° 唱针落在唱片最外圈纹路，10° 落在贴纸外沿，按 .tonearm 的支点和长度实测。
const ARM_REST = -14
const ARM_INNER = 10
const ARM_OUTER = -6
const ARM_MS = 600
// 换歌时旧唱片向左滑出的时长，与 .vinyl-out 动画一致。
const SWAP_MS = 500

function rotate(deg) {
  const t = 'rotate(' + deg + 'deg)'
  return { WebkitTransform: t, transform: t }
}

// 黑胶唱片。换歌流程：唱臂抬回支架 → 旧唱片向左滑出、露出新唱片 → 新歌真正出声后唱臂落下 → 唱片开始转。
// 暂停时唱臂抬起；播放中途缓冲时唱臂不动、唱片停转。
function Vinyl({ song, playing, loading, anim }) {
  const p = useProgress()
  const [readyId, setReadyId] = useState('')
  const [settled, setSettled] = useState(false)
  const [, force] = useState(0)
  const last = useRef(song)
  const out = useRef(null)
  const armWasOn = useRef(false)
  const dropAngle = useRef(null)

  // 换歌要在渲染时就记下旧唱片，旧唱片的节点才能原样保留（保持转到一半的角度）再滑出。
  if (last.current.id !== song.id) {
    out.current = anim ? { song: last.current, delay: armWasOn.current ? ARM_MS : 0 } : null
    last.current = song
  }
  const swap = out.current

  useEffect(() => {
    if (!swap) return
    const t = setTimeout(() => {
      out.current = null
      force((n) => n + 1)
    }, swap.delay + SWAP_MS)
    return () => clearTimeout(t)
  }, [swap])

  // 当前这首真正出声过才算就绪；中途缓冲不影响，换歌后要等新歌出声。
  useEffect(() => {
    if (playing && !loading) setReadyId(song.id)
  }, [playing, loading, song.id])

  const armOn = anim && playing && readyId === song.id && !swap
  armWasOn.current = armOn

  useEffect(() => {
    if (!armOn) {
      setSettled(false)
      return
    }
    const t = setTimeout(() => setSettled(true), ARM_MS)
    return () => clearTimeout(t)
  }, [armOn])

  const spinning = armOn && settled && !loading

  // 落臂动画期间目标角度固定，否则每次进度更新都会打断缓动，看起来一顿一顿的。
  const ratio = p.duration > 0 ? Math.min(p.current / p.duration, 1) : 0
  const target = ARM_OUTER + (ARM_INNER - ARM_OUTER) * ratio
  let angle = ARM_REST
  if (!armOn) {
    dropAngle.current = null
  } else if (!settled) {
    if (dropAngle.current == null) dropAngle.current = target
    angle = dropAngle.current
  } else {
    angle = Math.round(target * 20) / 20
  }

  const discs = swap ? [swap.song, song] : [song]

  return (
    <div class="vinyl">
      {discs.map((s) => {
        const isOut = swap && s === swap.song
        const delay = isOut ? swap.delay + 'ms' : null
        return (
          <div key={s.id} class={'vinyl-slot' + (isOut ? ' vinyl-out' : '')} style={isOut ? { WebkitAnimationDelay: delay, animationDelay: delay } : null}>
            <div class={'vinyl-disc' + (anim ? ' cover-spin' : '') + (!isOut && spinning ? '' : ' cover-paused')}>
              <div class="vinyl-label" style={s.coverArt ? { backgroundImage: `url("${coverUrl(s.coverArt, 600)}")` } : null} />
              <div class="vinyl-hole" />
            </div>
          </div>
        )
      })}
      <div class="vinyl-sheen" />
      {anim ? (
        <div>
          <div class="tonearm-rest" />
          <div class="tonearm-base" />
          <div class={'tonearm' + (settled && armOn ? ' tonearm-track' : '')} style={rotate(angle)}>
            <div class="tonearm-weight" />
            <div class="tonearm-rod" />
            <div class="tonearm-head" />
          </div>
          <div class="tonearm-cap" />
        </div>
      ) : null}
    </div>
  )
}

// 自己实现的进度条：旧 Safari 的 input[type=range] 样式不好统一，触摸体验也差。
function Slider() {
  const p = useProgress()
  const ref = useRef(null)
  const [drag, setDrag] = useState(null)
  const total = p.duration || 0
  const ratio = drag != null ? drag : total > 0 ? Math.min(p.current / total, 1) : 0

  const ratioAt = (e) => {
    const point = e.touches && e.touches.length ? e.touches[0] : e.changedTouches ? e.changedTouches[0] : e
    const rect = ref.current.getBoundingClientRect()
    return Math.max(0, Math.min((point.clientX - rect.left) / rect.width, 1))
  }

  const start = (e) => {
    if (total <= 0) return
    e.preventDefault()
    setDrag(ratioAt(e))
    const touch = e.type === 'touchstart'
    const move = (ev) => {
      ev.preventDefault()
      setDrag(ratioAt(ev))
    }
    const end = (ev) => {
      seek(ratioAt(ev))
      setDrag(null)
      document.removeEventListener(touch ? 'touchmove' : 'mousemove', move)
      document.removeEventListener(touch ? 'touchend' : 'mouseup', end)
    }
    document.addEventListener(touch ? 'touchmove' : 'mousemove', move, { passive: false })
    document.addEventListener(touch ? 'touchend' : 'mouseup', end)
  }

  return (
    <div class="slider-wrap">
      <span class="slider-time">{fmtTime(drag != null ? drag * total : p.current)}</span>
      <div class={'slider' + (drag != null ? ' slider-drag' : '')} ref={ref} onMouseDown={start} onTouchStart={start}>
        <div class="slider-track">
          <div class="slider-fill" style={{ width: ratio * 100 + '%' }} />
        </div>
        <div class="slider-thumb" style={{ left: ratio * 100 + '%' }} />
      </div>
      <span class="slider-time">{fmtTime(total)}</span>
    </div>
  )
}

function MiniProgress() {
  const p = useProgress()
  const ratio = p.duration > 0 ? Math.min(p.current / p.duration, 1) : 0
  return (
    <div class="mini-progress">
      <div class="slider-fill" style={{ width: ratio * 100 + '%' }} />
    </div>
  )
}

function PlayToggle({ big }) {
  const p = usePlayer()
  return (
    <button class={'icon-btn' + (big ? ' play-big' : ' play-btn')} onClick={toggle} aria-label={p.playing ? '暂停' : '播放'}>
      <Icon name={p.playing ? 'pause' : 'play'} size={big ? 36 : 28} />
    </button>
  )
}

function modeOf(id) {
  for (let i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i]
  return MODES[0]
}

function ModeButton({ labeled }) {
  const p = usePlayer()
  const m = modeOf(p.mode)
  return (
    <button class={'icon-btn' + (labeled ? ' mode-btn' : '')} onClick={cycleMode} aria-label={'播放模式：' + m.name} title={m.name}>
      <Icon name={m.icon} size={labeled ? 22 : 24} />
      {labeled ? <span class="mode-name">{m.name}</span> : null}
    </button>
  )
}

export function PlayerBar({ onExpand, onToggleQueue, queueOpen }) {
  usePlayer()
  const song = currentSong()
  if (!song) return null
  return (
    <div class="player-bar">
      <MiniProgress />
      <div class="player-bar-info" role="button" aria-label="打开播放页" onClick={onExpand}>
        <Cover id={song.coverArt} size={150} eager />
        <div class="player-bar-text">
          <div class="player-bar-title">{song.title}</div>
          <div class="player-bar-sub">{song.artist}</div>
        </div>
      </div>
      <div class="player-bar-center">
        <div class="player-bar-controls">
          <button class="icon-btn hide-mobile" onClick={prev} aria-label="上一首">
            <Icon name="prev" />
          </button>
          <PlayToggle />
          <button class="icon-btn" onClick={next} aria-label="下一首">
            <Icon name="next" />
          </button>
        </div>
        <div class="hide-mobile">
          <Slider />
        </div>
      </div>
      {/* 手机上没有其它播放列表入口，这里给一个拇指容易够到的队列按钮 */}
      <button
        class={'icon-btn hide-desktop queue-trigger' + (queueOpen ? ' is-on' : '')}
        onClick={onToggleQueue}
        aria-label="播放列表"
        aria-expanded={queueOpen}
        title="播放列表"
      >
        <Icon name="queue" />
      </button>
      <div class="player-bar-right hide-mobile">
        <ModeButton />
        <button class="icon-btn" onClick={onExpand} aria-label="播放列表">
          <Icon name="queue" />
        </button>
      </div>
    </div>
  )
}

function Queue({ show, onPick }) {
  const p = usePlayer()
  const box = useRef(null)
  const hold = useRef(0)
  // 队列是一条一直往下延伸的时间线：前后各取一段渲染，当前歌曲永远在窗口里。
  const view = queueView()
  const total = p.queue.length

  // 切歌、切模式、打开列表后，把当前歌曲滚到视口偏上的位置，下面留出接下来要播的歌。
  useEffect(() => {
    const el = box.current
    if (!el) return
    const row = el.querySelector('.queue-active')
    if (!row) return
    // 用户刚在列表里拖动或点过，就先别抢滚动位置，等下一次切歌再接管。
    if (Date.now() - hold.current < 1200) return
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top
    el.scrollTop = Math.max(0, el.scrollTop + top - el.clientHeight * 0.35)
  }, [show, p.mode, total, view.active])

  const touched = () => {
    hold.current = Date.now()
  }

  return (
    <ol class="queue" ref={box} onTouchStart={touched} onMouseDown={touched} onWheel={touched}>
      {view.rows.map((row) => {
        const s = p.queue[row.index]
        const roundStart = row.seq > 0 && row.seq % total === 0
        return (
          <li
            key={row.seq}
            class={'queue-item' + (row.seq === view.active ? ' queue-active' : '') + (roundStart ? ' queue-round' : '')}
            onClick={() => {
              playAt(row.index, row.seq)
              if (onPick) onPick()
            }}
          >
            <span class="track-title">{s.title}</span>
            <span class="track-sub">{s.artist}</span>
          </li>
        )
      })}
    </ol>
  )
}

// 小屏底部播放条上的队列入口：贴着播放条弹出，点外面、再点按钮或关闭键收起。
export function QueuePopover({ onClose }) {
  const p = usePlayer()
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.keyCode === 27) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!p.queue.length) return null
  return (
    <div>
      <div class="queue-pop-mask" onClick={onClose} />
      <div class="queue-pop" role="dialog" aria-label="播放列表">
        <div class="queue-pop-head">
          <span class="queue-pop-title">播放列表</span>
          <span class="queue-pop-count">{p.queue.length} 首</span>
          <button class="icon-btn queue-pop-close" onClick={onClose} aria-label="收起播放列表">
            <Icon name="close" size={20} />
          </button>
        </div>
        <Queue show onPick={onClose} />
        <span class="queue-pop-arrow" />
      </div>
    </div>
  )
}

export function FullPlayer({ onClose }) {
  const p = usePlayer()
  const [showQueue, setShowQueue] = useState(false)
  const [showLyrics, setShowLyrics] = useState(loadLyricsPref)
  const [coverPref, setCoverPref] = useState(loadCoverPref)
  const [showCoverMenu, setShowCoverMenu] = useState(false)
  const song = currentSong()
  if (!song) return null
  const bg = blurUrl(song.coverArt)
  const close = () => onClose()
  const toggleLyrics = () => {
    const on = showQueue || !showLyrics
    setShowQueue(false)
    setShowLyrics(on)
    saveLyricsPref(on)
  }
  const changeCover = (pref) => {
    setCoverPref(pref)
    saveCoverPref(pref)
  }

  return (
    <div class="full">
      <div class="full-bg" style={bg ? { backgroundImage: `url("${bg}")` } : null} />
      <div class="full-shade" />
      <div class="full-inner">
        <div class="full-top">
          <button class="icon-btn" onClick={close} aria-label="收起">
            <Icon name="down" size={30} />
          </button>
          <span class="full-label">正在播放</span>
          <div class="full-actions">
            <button class={'icon-btn' + (showCoverMenu ? ' is-on' : '')} onClick={() => setShowCoverMenu(!showCoverMenu)} aria-label="封面样式">
              <Icon name="album" />
            </button>
            <button class={'icon-btn' + (showLyrics && !showQueue ? ' is-on' : '')} onClick={toggleLyrics} aria-label="歌词">
              <Icon name="lyrics" />
            </button>
            <button class={'icon-btn only-narrow' + (showQueue ? ' is-on' : '')} onClick={() => setShowQueue(!showQueue)} aria-label="播放列表">
              <Icon name="queue" />
            </button>
            {showCoverMenu ? <CoverMenu pref={coverPref} onChange={changeCover} onClose={() => setShowCoverMenu(false)} /> : null}
          </div>
        </div>
        <div class={'full-body' + (showQueue ? ' show-queue' : '')}>
          <div class={'full-main' + (showLyrics ? ' show-lyrics' : '')}>
            {showLyrics ? (
              <Lyrics song={song} />
            ) : (
              <div class="full-cover" role="button" aria-label="显示歌词" onClick={toggleLyrics}>
                {coverPref.round ? (
                  <Vinyl song={song} playing={p.playing} loading={p.loading} anim={coverPref.anim} />
                ) : (
                  <div class="cover">
                    <div class="cover-img" style={song.coverArt ? { backgroundImage: `url("${coverUrl(song.coverArt, 600)}")` } : null} />
                  </div>
                )}
              </div>
            )}
            <div class="full-meta">
              <div class="full-title">{song.title}</div>
              <div class="full-sub">
                {song.artistId ? (
                  <a href={href('artist', song.artistId)} onClick={close}>{song.artist}</a>
                ) : (
                  song.artist
                )}
                {song.album ? ' · ' : ''}
                {song.albumId ? (
                  <a href={href('album', song.albumId)} onClick={close}>{song.album}</a>
                ) : (
                  song.album
                )}
              </div>
              {p.error ? <div class="full-error">{p.error}</div> : null}
            </div>
            <Slider />
            <div class="full-controls">
              <ModeButton labeled />
              <button class="icon-btn" onClick={prev} aria-label="上一首">
                <Icon name="prev" size={34} />
              </button>
              <PlayToggle big />
              <button class="icon-btn" onClick={next} aria-label="下一首">
                <Icon name="next" size={34} />
              </button>
              <span class="mode-spacer" />
            </div>
            {p.loading ? <div class="full-hint">正在缓冲…</div> : null}
          </div>
          <div class="full-queue">
            <div class="full-queue-title">播放列表 · {p.queue.length} 首</div>
            <Queue show={showQueue} onPick={() => setShowQueue(false)} />
          </div>
        </div>
      </div>
    </div>
  )
}
