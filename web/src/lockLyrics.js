import { api } from './api'
import { currentSong, currentTime, setMediaLine, subscribe } from './player'

// 锁屏歌词：把当前这句歌词写进 Media Session 的标题，锁屏、通知栏、系统媒体浮层里就能看到。
const KEY = 'sm_lock_lyrics'
const LEAD_MS = 200

export const lockLyricsSupported = !!(navigator.mediaSession && typeof window.MediaMetadata === 'function')

let enabled = false
let songId = ''
let lines = null
let shown = -1

try {
  enabled = lockLyricsSupported && window.localStorage.getItem(KEY) === '1'
} catch (e) {}

export function lockLyricsOn() {
  return enabled
}

export function setLockLyrics(on) {
  enabled = on
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch (e) {}
  songId = ''
  lines = null
  shown = -1
  if (on) sync()
  else setMediaLine('')
}

function tick() {
  if (!lines) return
  const ms = currentTime() * 1000 + LEAD_MS
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time > ms) break
    found = i
  }
  if (found === shown) return
  shown = found
  setMediaLine(found >= 0 ? lines[found].text || '' : '')
}

function sync() {
  if (!enabled) return
  const song = currentSong()
  if (!song) return
  if (song.id === songId) {
    tick()
    return
  }
  songId = song.id
  lines = null
  shown = -1
  const id = song.id
  api.lyrics(song).then(
    (data) => {
      if (!enabled || songId !== id) return
      lines = data && data.synced && data.lines && data.lines.length ? data.lines : null
      tick()
    },
    () => {},
  )
}

subscribe('state', sync)
subscribe('progress', sync)
