import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import legacy from '@vitejs/plugin-legacy'

const outDir = fileURLToPath(new URL('../server/webui/dist', import.meta.url))
const buildId = Date.now().toString(36)

function listFiles(dir, prefix) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), prefix + entry.name + '/'))
    else if (!entry.name.endsWith('.map')) out.push(prefix + entry.name)
  }
  return out
}

// 打包结束后生成 sw.js（缓存名带版本号）和 version.json（页面定时比对，发现新版本就刷新）。
function pwa() {
  return {
    name: 'simplemusic-pwa',
    apply: 'build',
    closeBundle() {
      const assets = listFiles(join(outDir, 'assets'), '/assets/')
      const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
        .replace('__BUILD_ID__', buildId)
        .replace('__PRECACHE__', JSON.stringify(assets))
      writeFileSync(join(outDir, 'sw.js'), sw)
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version: buildId }))
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    preact(),
    legacy({
      targets: ['ios >= 10.3', 'safari >= 10.1', 'chrome >= 49', 'android >= 5', 'firefox >= 52', 'edge >= 16'],
    }),
    pwa(),
  ],
  build: {
    outDir,
    emptyOutDir: true,
    cssTarget: ['safari10', 'chrome49'],
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
})
