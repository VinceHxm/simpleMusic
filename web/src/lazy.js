// 封面懒加载：只给进入可视区（含上下各一屏预加载）的元素设置背景图。
// iOS 12.2 以前没有 IntersectionObserver，这里用节流的滚动检查代替。
const pending = []
let timer = 0

function check() {
  timer = 0
  const h = window.innerHeight || document.documentElement.clientHeight
  for (let i = pending.length - 1; i >= 0; i--) {
    const item = pending[i]
    if (!document.body.contains(item.el)) {
      pending.splice(i, 1)
      continue
    }
    const r = item.el.getBoundingClientRect()
    if (r.width && r.bottom > -h && r.top < h * 2) {
      item.el.style.backgroundImage = 'url("' + item.url + '")'
      pending.splice(i, 1)
    }
  }
}

function schedule() {
  if (!timer) timer = setTimeout(check, 80)
}

window.addEventListener('scroll', schedule)
window.addEventListener('resize', schedule)

export function lazyBackground(el, url) {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].el === el) pending.splice(i, 1)
  }
  el.style.backgroundImage = ''
  if (!url) return
  pending.push({ el, url })
  schedule()
}

export function recheckLazy() {
  schedule()
}
