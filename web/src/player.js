import { useEffect, useState } from 'preact/hooks'
import { api, coverUrl, streamUrl } from './api'

const STORAGE_KEY = 'sm_queue'
const MODE_KEY = 'sm_mode'

// 点击模式按钮时按这个顺序轮换。
export const MODES = [
  { id: 'one', name: '单曲循环', icon: 'repeatOne' },
  { id: 'loop', name: '列表循环', icon: 'repeat' },
  { id: 'shuffleLoop', name: '随机循环', icon: 'shuffle' },
  { id: 'list', name: '顺序播放', icon: 'playlist' },
  { id: 'shuffle', name: '随机播放', icon: 'shuffleOnce' },
]

function loadMode() {
  try {
    const id = window.localStorage.getItem(MODE_KEY)
    for (let i = 0; i < MODES.length; i++) if (MODES[i].id === id) return id
  } catch (e) {}
  return 'list'
}

const state = {
  queue: [],
  index: -1,
  mode: loadMode(),
  playing: false,
  loading: false,
  error: '',
  current: 0,
  duration: 0,
}

// 播放进度每秒触发好几次，单独一个频道，避免整页跟着重渲染拖慢老设备。
const channels = { state: [], progress: [] }
let audio = null
// 当前歌曲播放时把下一首完整下载到内存，切歌时同一个播放器直接换成本地数据。
// 小米等系统息屏后会限制后台联网，切歌时再去请求新地址就会停在那里不播。
// 不能换成第二个 Audio：iOS 和安卓 WebView 要求每个播放器都由用户点过才允许自动播放。
let nextId = ''
let nextUrl = ''
let nextXhr = null
let audioBlob = ''
// 当前歌曲缓冲完或只剩这么多秒时才下载下一首，免得和当前歌曲抢带宽。
const PRELOAD_TAIL = 30
let scrobbled = false
let mediaLine = ''

// 随机模式按“轮”组织：rounds[roundIdx - baseRound] 是当前轮及之后各轮的下标顺序，
// pos 是当前歌曲在当轮中的位置。轮次按需往后生成，队列列表可以一直往下铺。
// 这样切换模式时队列显示不变，“上一首”也能按随机顺序往回退。
let rounds = []
let baseRound = 0
let roundIdx = 0
let pos = 0
// 列表循环已经播完的整轮数，用来算出当前歌曲在“一直往下滚”的队列里是第几行。
let laps = 0
// 队列列表最多回看这么多行，避免长时间循环后 DOM 无限增长。
const QUEUE_BACK = 80

function emit(channel) {
  channels[channel].slice().forEach((fn) => fn())
}

function set(patch) {
  Object.assign(state, patch)
  emit('state')
}

export function subscribe(channel, fn) {
  channels[channel].push(fn)
  return () => {
    const list = channels[channel]
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
}

function useChannel(channel) {
  const [, force] = useState(0)
  useEffect(() => subscribe(channel, () => force((n) => n + 1)), [])
  return state
}

export const usePlayer = () => useChannel('state')
export const useProgress = () => useChannel('progress')

export function isPlaying() {
  return state.playing
}

export function currentSong() {
  return state.queue[state.index] || null
}

export function currentTime() {
  return state.current
}

function isShuffle(mode) {
  return mode === 'shuffle' || mode === 'shuffleLoop'
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = list[i]
    list[i] = list[j]
    list[j] = t
  }
  return list
}

function currentRound() {
  return rounds[roundIdx - baseRound] || []
}

// 当前歌曲在整条“一直往下滚”的队列里的序号。随机模式每一轮长度都等于队列长度。
function activeSeq() {
  const n = state.queue.length
  if (isShuffle(state.mode)) return roundIdx * n + pos
  if (state.mode === 'loop') return laps * n + state.index
  return state.index
}

// 当前歌曲排第一，其余随机。
function buildOrder() {
  const rest = []
  for (let i = 0; i < state.queue.length; i++) if (i !== state.index) rest.push(i)
  shuffleInPlace(rest)
  rounds = [state.index >= 0 ? [state.index].concat(rest) : rest]
  baseRound = 0
  roundIdx = 0
  pos = 0
}

// 以最后一轮为基础重新洗牌，并避免第一首正好是上一轮刚播完的那首。
function newRound(after) {
  const prev = rounds.length ? rounds[rounds.length - 1] : []
  const list = shuffleInPlace(prev.slice())
  if (list.length > 1 && list[0] === after) {
    list[0] = list[list.length - 1]
    list[list.length - 1] = after
  }
  return list
}

// g 是全局轮次编号；轮次按需生成，列表提前往下铺时和真正播放时取到的是同一份。
function ensureRound(g) {
  if (g < baseRound) return false
  while (baseRound + rounds.length <= g) {
    const prev = rounds.length ? rounds[rounds.length - 1] : []
    const after = prev.length ? prev[prev.length - 1] : state.index
    rounds.push(newRound(after))
  }
  return true
}

// 只保留当前轮附近几轮，长时间循环也不会一直吃内存。
function pruneRounds() {
  while (rounds.length > 6 && roundIdx - baseRound > 4) {
    rounds.shift()
    baseRound++
  }
}

function occurrenceAt(seq) {
  const n = state.queue.length
  if (isShuffle(state.mode)) {
    const r = Math.floor(seq / n)
    if (!ensureRound(r)) return -1
    const round = rounds[r - baseRound]
    const index = round ? round[seq % n] : -1
    return index >= 0 ? index : -1
  }
  return seq % n
}

// 队列展示窗口：始终包含当前歌曲。当前轮快播完时，提前把下一轮接在下面；
// 随机循环提前生成的下一轮和真正播到的是同一份数据，所以列表不会跳变。
export function queueView() {
  const n = state.queue.length
  if (!n) return { rows: [], active: -1 }
  const active = activeSeq()
  // 只有一首歌时循环没有“下一段”可言，重复铺同样的行没有意义。
  if (n === 1) return { rows: [{ seq: active, index: 0 }], active: active }

  // 当前轮只剩这么多首时补下一轮；队列很短时也至少留两首，避免一打开就重复。
  const prepend = Math.min(6, Math.max(2, Math.floor(n / 3)))
  let start = active - QUEUE_BACK
  let end = active
  if (isShuffle(state.mode)) {
    const oldest = baseRound * n
    if (start < oldest) start = oldest
    end = (roundIdx + 1) * n - 1
    if (state.mode === 'shuffleLoop' && pos >= n - prepend) {
      ensureRound(roundIdx + 1)
      end = (roundIdx + 2) * n - 1
    }
  } else if (state.mode === 'loop') {
    if (start < 0) start = 0
    const round = Math.floor(active / n)
    end = (round + 1) * n - 1
    if (active % n >= n - prepend) end = (round + 2) * n - 1
  } else if (state.mode === 'list') {
    if (start < 0) start = 0
    end = n - 1
  } else {
    start = 0
    end = n - 1
  }
  const rows = []
  for (let seq = start; seq <= end; seq++) {
    const index = occurrenceAt(seq)
    if (index >= 0) rows.push({ seq: seq, index: index })
  }
  return { rows: rows, active: active }
}

// auto 表示一首播完自动切歌；手动点“下一首”时单曲循环也照常往后切。返回 -1 表示停止。
function peekNext(auto) {
  const n = state.queue.length
  if (!n) return -1
  const mode = state.mode
  if (mode === 'one' && auto) return state.index
  if (isShuffle(mode)) {
    const round = currentRound()
    if (pos + 1 < round.length) return round[pos + 1]
    if (mode !== 'shuffleLoop') return -1
    ensureRound(roundIdx + 1)
    const next = rounds[roundIdx + 1 - baseRound]
    return next && next.length ? next[0] : -1
  }
  if (state.index + 1 < n) return state.index + 1
  return mode === 'list' ? -1 : 0
}

function ensureAudio() {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'auto'
  const ms = navigator.mediaSession
  if (ms && ms.setActionHandler) {
    // 耳机、蓝牙、锁屏发来的是明确的播放或暂停，不能当成切换，否则状态不同步时会按反。
    ms.setActionHandler('play', () => {
      if (audio.paused) toggle()
    })
    ms.setActionHandler('pause', () => {
      if (!audio.paused) audio.pause()
    })
    ms.setActionHandler('previoustrack', prev)
    ms.setActionHandler('nexttrack', next)
  }
  audio.addEventListener('playing', () => {
    set({ playing: true, loading: false, error: '' })
    maybePreload()
  })
  audio.addEventListener('pause', () => set({ playing: false }))
  audio.addEventListener('waiting', () => set({ loading: true }))
  audio.addEventListener('progress', maybePreload)
  audio.addEventListener('timeupdate', () => {
    state.current = audio.currentTime
    emit('progress')
    maybeScrobble()
    maybePreload()
  })
  audio.addEventListener('durationchange', () => {
    const d = audio.duration
    if (isFinite(d) && d > 0) {
      state.duration = d
      emit('progress')
    }
  })
  audio.addEventListener('ended', () => advance(true))
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return
    set({ playing: false, loading: false, error: '这首歌暂时无法播放' })
  })
  return audio
}

function dropNext() {
  if (nextXhr) {
    nextXhr.abort()
    nextXhr = null
  }
  if (nextUrl) window.URL.revokeObjectURL(nextUrl)
  nextId = ''
  nextUrl = ''
}

// blob 为 true 表示 url 是本地数据，换下一个地址时要释放掉。
function setSrc(url, blob) {
  if (audioBlob) window.URL.revokeObjectURL(audioBlob)
  audioBlob = blob ? url : ''
  if (url) {
    audio.src = url
  } else {
    audio.removeAttribute('src')
    audio.load()
  }
}

function maybeScrobble() {
  const song = currentSong()
  if (scrobbled || !song) return
  const total = state.duration || song.duration || 0
  if (total > 0 && state.current >= Math.min(total / 2, 240)) {
    scrobbled = true
    api.scrobble(song.id, true).catch(() => {})
  }
}

function maybePreload() {
  const d = audio.duration
  if (!isFinite(d) || d <= 0) return
  const b = audio.buffered
  if (d - audio.currentTime < PRELOAD_TAIL || (b.length && b.end(b.length - 1) >= d - 1)) preloadNext()
}

// 请求流地址时服务端会顺带转码，下载失败就留到切歌时再走网络。
function preloadNext() {
  const i = peekNext(true)
  const song = i >= 0 && i !== state.index ? state.queue[i] : null
  if (!song || nextId === song.id) return
  dropNext()
  if (!window.URL || !window.URL.createObjectURL) return
  nextId = song.id
  const xhr = new XMLHttpRequest()
  nextXhr = xhr
  xhr.open('GET', streamUrl(song.id), true)
  xhr.responseType = 'blob'
  xhr.onload = () => {
    if (nextXhr !== xhr) return
    nextXhr = null
    if (xhr.status === 200 && xhr.response) nextUrl = window.URL.createObjectURL(xhr.response)
  }
  xhr.onerror = () => {
    if (nextXhr === xhr) nextXhr = null
  }
  xhr.send()
}

function load(autoplay) {
  const song = currentSong()
  if (!song) return
  const el = ensureAudio()
  if (nextId === song.id && nextUrl) {
    const url = nextUrl
    nextId = ''
    nextUrl = ''
    setSrc(url, true)
  } else {
    setSrc(streamUrl(song.id))
  }
  scrobbled = false
  state.current = 0
  state.duration = song.duration || 0
  set({ loading: autoplay, error: '' })
  emit('progress')
  if (autoplay) {
    const p = el.play()
    if (p && p.catch) p.catch(() => set({ playing: false, loading: false }))
    api.scrobble(song.id, false).catch(() => {})
  }
  mediaLine = ''
  updateMediaSession(song)
  document.title = song.title + ' - 简单听'
  save()
}

function replay() {
  const song = currentSong()
  if (!audio || !song) return
  scrobbled = false
  audio.currentTime = 0
  const p = audio.play()
  if (p && p.catch) p.catch(() => set({ playing: false, loading: false }))
  api.scrobble(song.id, false).catch(() => {})
}

function advance(auto) {
  const i = peekNext(auto)
  if (i < 0) {
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    return
  }
  if (auto && i === state.index) {
    replay()
    return
  }
  if (isShuffle(state.mode)) {
    if (pos + 1 < currentRound().length) {
      pos++
    } else {
      ensureRound(roundIdx + 1)
      roundIdx++
      pos = 0
      pruneRounds()
    }
  } else if (state.mode === 'loop' && i === 0 && state.index === state.queue.length - 1) {
    laps++
  }
  state.index = i
  load(true)
}

// shuffle 为 true 时把传入的列表本身打乱；播放模式沿用当前模式。
export function playList(songs, start, shuffle) {
  if (!songs || !songs.length) return
  state.queue = shuffle ? shuffleInPlace(songs.slice()) : songs.slice()
  state.index = shuffle ? 0 : Math.min(Math.max(start || 0, 0), songs.length - 1)
  laps = 0
  if (isShuffle(state.mode)) {
    buildOrder()
  } else {
    rounds = []
    baseRound = 0
    roundIdx = 0
    pos = 0
  }
  load(true)
}

// 专辑、歌单页的“按指定模式从头播放”：先把模式切过去，再重排队列并从头播。
export function playAll(songs, mode) {
  if (!songs || !songs.length) return
  if (mode && mode !== state.mode) {
    state.mode = mode
    try {
      window.localStorage.setItem(MODE_KEY, mode)
    } catch (e) {}
  }
  const shuffle = isShuffle(state.mode)
  state.queue = shuffle ? shuffleInPlace(songs.slice()) : songs.slice()
  state.index = 0
  laps = 0
  if (shuffle) {
    buildOrder()
  } else {
    rounds = []
    baseRound = 0
    roundIdx = 0
    pos = 0
  }
  load(true)
}

// seq 是这一行在滚动队列里的序号；点重复出现的同一首歌时，从点中的那一段接着播。
export function playAt(index, seq) {
  const n = state.queue.length
  if (index < 0 || index >= n) return
  if (isShuffle(state.mode)) {
    if (seq != null && isFinite(seq)) {
      const r = Math.floor(seq / n)
      const within = seq % n
      if (ensureRound(r) && rounds[r - baseRound] && rounds[r - baseRound][within] === index) {
        roundIdx = r
        pos = within
        state.index = index
        pruneRounds()
        load(true)
        return
      }
    }
    // 没带队列位置（例如曲目列表点歌）：在当前轮里定位，找不到就重新洗牌。
    const j = currentRound().indexOf(index)
    if (j >= 0) pos = j
    else buildOrder()
  } else {
    state.index = index
    laps = seq != null && isFinite(seq) && state.mode === 'loop' ? Math.max(0, Math.floor(seq / n)) : 0
  }
  load(true)
}

export function setMode(mode) {
  if (mode === state.mode) return
  const wasShuffle = isShuffle(state.mode)
  state.mode = mode
  // 换模式时重新以当前歌曲为起点铺队列，避免带着上一模式的轮数跳到很远的位置。
  laps = 0
  if (isShuffle(mode)) {
    if (!wasShuffle) buildOrder()
  } else {
    rounds = []
    baseRound = 0
    roundIdx = 0
    pos = 0
  }
  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch (e) {}
  save()
  emit('state')
  if (state.playing) maybePreload()
}

export function cycleMode() {
  let i = 0
  while (i < MODES.length && MODES[i].id !== state.mode) i++
  setMode(MODES[(i + 1) % MODES.length].id)
}

export function toggle() {
  const el = ensureAudio()
  if (!el.getAttribute('src')) {
    load(true)
    return
  }
  if (el.paused) {
    const p = el.play()
    if (p && p.catch) p.catch(() => {})
  } else {
    el.pause()
  }
}

export function next() {
  advance(false)
}

export function prev() {
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0
    return
  }
  if (isShuffle(state.mode)) {
    if (pos > 0) {
      pos--
    } else if (roundIdx > baseRound) {
      roundIdx--
      pos = currentRound().length - 1
    } else {
      return
    }
    state.index = currentRound()[pos]
    load(true)
    return
  }
  if (state.index > 0) {
    state.index--
  } else if (state.mode !== 'list' && state.queue.length > 1) {
    state.index = state.queue.length - 1
    if (state.mode === 'loop') laps = Math.max(0, laps - 1)
  } else {
    return
  }
  load(true)
}

export function seek(ratio) {
  seekTo((state.duration || 0) * ratio)
}

export function seekTo(sec) {
  if (!audio || !audio.getAttribute('src')) return
  const total = state.duration || 0
  if (total <= 0) return
  audio.currentTime = Math.max(0, Math.min(sec, total - 0.5))
  state.current = audio.currentTime
  emit('progress')
}

// 有锁屏歌词时，标题显示当前这句歌词，歌名和歌手挪到第二行。
function updateMediaSession(song) {
  const ms = navigator.mediaSession
  if (!ms || typeof window.MediaMetadata !== 'function') return
  ms.metadata = new window.MediaMetadata({
    title: mediaLine || song.title,
    artist: mediaLine ? song.title + (song.artist ? ' - ' + song.artist : '') : song.artist || '',
    album: song.album || '',
    artwork: song.coverArt ? [{ src: coverUrl(song.coverArt, 600), sizes: '600x600' }] : [],
  })
}

export function setMediaLine(line) {
  if (line === mediaLine) return
  mediaLine = line
  const song = currentSong()
  if (song) updateMediaSession(song)
}

// iOS 隐私模式下 localStorage 写入会抛异常，读写都要包一层。
function save() {
  try {
    const data = { queue: state.queue, index: state.index, laps: laps }
    if (isShuffle(state.mode)) {
      data.order = currentRound()
      data.pos = pos
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (e) {}
}

export function restore() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved && saved.queue && saved.queue.length) {
      state.queue = saved.queue
      state.index = Math.min(Math.max(saved.index, 0), saved.queue.length - 1)
      state.duration = currentSong().duration || 0
      laps = state.mode === 'loop' ? Math.max(0, saved.laps || 0) : 0
      if (isShuffle(state.mode)) {
        const o = saved.order
        if (o && o.length === saved.queue.length && o[saved.pos] === state.index) {
          rounds = [o]
          baseRound = 0
          roundIdx = 0
          pos = saved.pos
        } else {
          buildOrder()
        }
      } else {
        rounds = []
        baseRound = 0
        roundIdx = 0
        pos = 0
      }
      emit('state')
    }
  } catch (e) {}
}

export function reset() {
  if (audio) {
    audio.pause()
    setSrc('')
  }
  dropNext()
  state.queue = []
  state.index = -1
  rounds = []
  baseRound = 0
  roundIdx = 0
  pos = 0
  laps = 0
  set({ playing: false, loading: false, error: '' })
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch (e) {}
}
