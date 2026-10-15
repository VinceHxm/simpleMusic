import { useEffect, useState } from 'preact/hooks'

// 用 hash 路由：不需要服务端配合，也不依赖 History API 的各种兼容细节。
function parse() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/')
  return { name: parts[0] || 'albums', id: parts[1] ? decodeURIComponent(parts[1]) : '' }
}

export function useRoute() {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const onChange = () => {
      setRoute(parse())
      setTimeout(() => window.scrollTo(0, 0), 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function href(name, id) {
  return '#/' + name + (id ? '/' + encodeURIComponent(id) : '')
}

export function go(name, id) {
  window.location.hash = href(name, id)
}
