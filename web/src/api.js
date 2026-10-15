// 统一用 XHR：Android 5 自带 WebView 没有 fetch，且 fetch 无法被 core-js 补齐。
let onUnauthorized = () => {}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url, true)
    xhr.setRequestHeader('Accept', 'application/json')
    if (body) xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.onload = () => {
      let data = null
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch (e) {
        data = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
        return
      }
      const err = new Error((data && data.error) || '请求失败（' + xhr.status + '）')
      err.status = xhr.status
      if (xhr.status === 401 && !/^\/api\/(login|me|setup)/.test(url)) onUnauthorized()
      reject(err)
    }
    xhr.onerror = () => reject(new Error('网络连接失败'))
    xhr.send(body ? JSON.stringify(body) : null)
  })
}

const enc = encodeURIComponent

// 前端内存缓存：返回上一页、重复打开同一个专辑时直接用上次的数据，不再等网络。
// 服务端另有一层缓存，这里有效期短一些，收藏、退出、换服务器时整体清空。
const memo = {}
const MEMO_TTL = 3 * 60 * 1000

function cachedGet(url) {
  const hit = memo[url]
  if (hit && Date.now() - hit.time < MEMO_TTL) return Promise.resolve(hit.data)
  return request('GET', url).then((data) => {
    memo[url] = { data, time: Date.now() }
    return data
  })
}

export function clearApiCache() {
  Object.keys(memo).forEach((k) => delete memo[k])
}

// Navidrome 地址只记在当前浏览器，换浏览器或清除站点数据后需要重新填写。
const SERVER_KEY = 'sm_server'

export function savedServer() {
  try {
    return window.localStorage.getItem(SERVER_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function saveServer(url) {
  try {
    window.localStorage.setItem(SERVER_KEY, url)
  } catch (e) {}
}

export const api = {
  setup: () => request('GET', '/api/setup'),
  testServer: (url) => request('POST', '/api/setup/test', { url }),
  me: () => request('GET', '/api/me'),
  login: (url, username, password) => request('POST', '/api/login', { url, username, password }),
  logout: () => request('POST', '/api/logout').then((res) => (clearApiCache(), res)),
  albums: (type, offset, size) => {
    const url = `/api/albums?type=${type}&offset=${offset}&size=${size}`
    return type === 'random' || type === 'recent' || type === 'frequent' ? request('GET', url) : cachedGet(url)
  },
  album: (id) => cachedGet('/api/albums/' + enc(id)),
  artists: () => cachedGet('/api/artists'),
  artist: (id) => cachedGet('/api/artists/' + enc(id)),
  playlists: () => cachedGet('/api/playlists'),
  playlist: (id) => cachedGet('/api/playlists/' + enc(id)),
  search: (q) => cachedGet('/api/search?q=' + enc(q)),
  random: (size) => request('GET', '/api/random?size=' + (size || 50)),
  star: (id, kind, on) =>
    request(on ? 'POST' : 'DELETE', `/api/star/${enc(id)}?kind=${kind}`).then((res) => (clearApiCache(), res)),
  scrobble: (id, submission) => request('POST', `/api/scrobble/${enc(id)}?submission=${submission ? 'true' : 'false'}`),
  lyrics: (song) =>
    cachedGet(`/api/lyrics/${enc(song.id)}?artist=${enc(song.artist || '')}&title=${enc(song.title || '')}`),
}

export const coverUrl = (id, size) => (id ? `/api/cover/${enc(id)}?size=${size || 300}` : '')
export const blurUrl = (id) => (id ? `/api/cover/${enc(id)}/blur` : '')
export const streamUrl = (id) => '/api/stream/' + enc(id)
