import { useEffect, useState } from 'preact/hooks'
import { api, coverUrl, streamUrl } from './api'

const STORAGE_KEY = 'sm_queue'
const MODE_KEY = 'sm_mode'

// 点击模式按钮时按这个顺序轮换。
export const MODES = [
  { id: 'one', name: '单曲循环', icon: 'repeatOne' },
  { id: 'loop', name: '列表循环', icon: 'repeat' },
  { id: 'shuffleLoop', name: '随机循环', icon: 'shuffle' },
  { id: 'list', name: '列表播放', icon: 'playlist' },
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

// 随机模式不打乱队列本身，而是按 order 里的下标顺序播放，pos 是当前歌曲在 order 中的位置。
// 这样切换模式时队列显示不变，“上一首”也能按随机顺序往回退。
let order = []
let pos = 0
// 随机循环下一轮的顺序，播到最后一首时提前生成，好预转码下一轮的第一首。
let nextRound = null

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

// 播放列表的展示顺序（队列下标）：随机模式按实际播放顺序，其余按队列原顺序。
export function playOrder() {
  if (isShuffle(state.mode) && order.length === state.queue.length) return order
  const list = []
  for (let i = 0; i < state.queue.length; i++) list.push(i)
  return list
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

// 当前歌曲排第一，其余随机。
function buildOrder() {
  const rest = []
  for (let i = 0; i < state.queue.length; i++) if (i !== state.index) rest.push(i)
  shuffleInPlace(rest)
  order = state.index >= 0 ? [state.index].concat(rest) : rest
  pos = 0
  nextRound = null
}

// 新一轮重新洗牌，并避免第一首正好是刚播完的那首。
function newRound() {
  const list = shuffleInPlace(order.slice())
  if (list.length > 1 && list[0] === state.index) {
    list[0] = list[list.length - 1]
    list[list.length - 1] = state.index
  }
  return list
}

// auto 表示一首播完自动切歌；手动点“下一首”时单曲循环也照常往后切。返回 -1 表示停止。
function peekNext(auto) {
  const n = state.queue.length
  if (!n) return -1
  const mode = state.mode
  if (mode === 'one' && auto) return state.index
  if (isShuffle(mode)) {
    if (pos + 1 < order.length) return order[pos + 1]
    if (mode !== 'shuffleLoop') return -1
    if (!nextRound) nextRound = newRound()
    return nextRound[0]
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
    if (pos + 1 < order.length) {
      pos++
    } else {
      order = nextRound || newRound()
      nextRound = null
      pos = 0
    }
  }
  state.index = i
  load(true)
}

export function playList(songs, start, shuffle) {
  if (!songs || !songs.length) return
  state.queue = shuffle ? shuffleInPlace(songs.slice()) : songs.slice()
  state.index = shuffle ? 0 : start || 0
  if (isShuffle(state.mode)) buildOrder()
  load(true)
}

export function playAt(index) {
  if (index < 0 || index >= state.queue.length) return
  // 随机模式下播放列表按随机顺序展示，点哪首就从那里接着往下播，和顺序模式一致。
  if (isShuffle(state.mode)) {
    const j = order.indexOf(index)
    if (j >= 0) {
      pos = j
    } else {
      order.splice(pos + 1, 0, index)
      pos++
    }
    nextRound = null
  }
  state.index = index
  load(true)
}

export function setMode(mode) {
  if (mode === state.mode) return
  const wasShuffle = isShuffle(state.mode)
  state.mode = mode
  if (isShuffle(mode) && !wasShuffle) buildOrder()
  nextRound = null
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
      state.index = order[pos]
      load(true)
    }
    return
  }
  if (state.index > 0) {
    state.index--
    load(true)
  } else if (state.mode !== 'list' && state.queue.length > 1) {
    state.index = state.queue.length - 1
    load(true)
  }
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
    const data = { queue: state.queue, index: state.index }
    if (isShuffle(state.mode)) {
      data.order = order
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
      if (isShuffle(state.mode)) {
        const o = saved.order
        if (o && o.length === saved.queue.length && o[saved.pos] === state.index) {
          order = o
          pos = saved.pos
        } else {
          buildOrder()
        }
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
  order = []
  pos = 0
  nextRound = null
  set({ playing: false, loading: false, error: '' })
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch (e) {}
}
