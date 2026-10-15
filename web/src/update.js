import { useEffect, useState } from 'preact/hooks'
import { isPlaying } from './player'

// 定时比对 /version.json 与当前构建号，发现新版本时：
// 页面从后台切回前台且没在播放 → 直接刷新；否则只提示，避免打断听歌或正在填写的表单。
const INTERVAL = 5 * 60 * 1000
const MIN_GAP = 60 * 1000

let ready = false
let lastCheck = 0
const listeners = []

function setReady() {
  if (ready) return
  ready = true
  listeners.slice().forEach((fn) => fn())
}

function fetchVersion(cb) {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', '/version.json?t=' + Date.now(), true)
  xhr.onload = () => {
    if (xhr.status !== 200) return
    try {
      cb(JSON.parse(xhr.responseText).version)
    } catch (e) {}
  }
  xhr.send()
}

export function reloadNow() {
  window.location.reload()
}

function check(resumed) {
  if (ready) {
    if (resumed && !isPlaying()) reloadNow()
    return
  }
  const now = Date.now()
  if (now - lastCheck < MIN_GAP) return
  lastCheck = now
  fetchVersion((version) => {
    if (!version || version === __BUILD_ID__) return
    const reg = window.__smSW
    if (reg && reg.update) reg.update()
    if (resumed && !isPlaying()) reloadNow()
    else setReady()
  })
}

export function startUpdateCheck() {
  if (!import.meta.env.PROD) return
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(
        (reg) => {
          window.__smSW = reg
        },
        () => {},
      )
    })
  }
  setInterval(() => check(false), INTERVAL)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check(true)
  })
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) check(true)
  })
}

export function useUpdateReady() {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.push(fn)
    return () => listeners.splice(listeners.indexOf(fn), 1)
  }, [])
  return ready
}
