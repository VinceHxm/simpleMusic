import { useEffect, useState } from 'preact/hooks'

export function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  useEffect(() => {
    let alive = true
    setState({ data: null, error: null, loading: true })
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    )
    return () => {
      alive = false
    }
  }, deps)
  return state
}

export function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '0:00'
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ':' + (r < 10 ? '0' : '') + r
}

export function fmtTotal(sec) {
  const m = Math.round((sec || 0) / 60)
  if (m < 60) return m + ' 分钟'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟'
}
