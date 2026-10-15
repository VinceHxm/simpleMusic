import { useState } from 'preact/hooks'
import { reloadNow, useUpdateReady } from '../update'

export function UpdateBanner() {
  const ready = useUpdateReady()
  const [hidden, setHidden] = useState(false)
  if (!ready || hidden) return null
  return (
    <div class="update-banner" role="status">
      <span class="update-text">简单听有新版本</span>
      <button class="update-later" onClick={() => setHidden(true)}>
        稍后
      </button>
      <button class="update-now" onClick={reloadNow}>
        刷新
      </button>
    </div>
  )
}
