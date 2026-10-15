// 构建时由 vite.config.js 替换占位符后输出到 dist/sw.js。
// 只缓存页面外壳（index.html 与带哈希的静态资源），接口、封面、音频一律直连。
var VERSION = '__BUILD_ID__'
var CACHE = 'sm-shell-' + VERSION
var PRECACHE = ['/', '/manifest.json'].concat(__PRECACHE__)

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE)
      })
      .then(function () {
        return self.skipWaiting()
      }),
  )
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf('sm-shell-') === 0 && key !== CACHE
            })
            .map(function (key) {
              return caches.delete(key)
            }),
        )
      })
      .then(function () {
        return self.clients.claim()
      }),
  )
})

self.addEventListener('fetch', function (event) {
  var req = event.request
  if (req.method !== 'GET') return
  var url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.indexOf('/api/') === 0 || url.pathname === '/version.json' || url.pathname === '/sw.js') return

  // 页面：优先联网拿最新 index.html，断网时用缓存。
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res.ok) {
            var copy = res.clone()
            caches.open(CACHE).then(function (cache) {
              cache.put('/', copy)
            })
          }
          return res
        })
        .catch(function () {
          return caches.match('/')
        }),
    )
    return
  }

  // 带哈希的资源内容不会变，缓存优先。
  if (url.pathname.indexOf('/assets/') === 0) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return (
          hit ||
          fetch(req).then(function (res) {
            if (res.ok) {
              var copy = res.clone()
              caches.open(CACHE).then(function (cache) {
                cache.put(req, copy)
              })
            }
            return res
          })
        )
      }),
    )
    return
  }

  event.respondWith(
    fetch(req).catch(function () {
      return caches.match(req)
    }),
  )
})
