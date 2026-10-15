# 简单听 · simpleMusic

面向旧设备的 Navidrome 网页播放器：Go 单文件后端 + Preact 前端，一套响应式页面覆盖手机、平板和桌面。

让吃灰的旧 iPhone、iPad、安卓平板也能流畅连上 [Navidrome](https://www.navidrome.org/) 听歌：后端负责转码为 MP3、生成封面缩略图并做缓存，前端体积小、兼容 ES5 浏览器。

## 功能

- 专辑、艺人、歌单、收藏、最近播放 / 最常播放、随机专辑浏览与搜索
- 播放队列、上一首 / 下一首、预转码下一首，支持拖动进度（HTTP Range）
- 滚动歌词，可选在锁屏显示歌词（依赖 Media Session）
- 锁屏 / 通知栏播放控制
- 可添加到主屏幕（PWA），新版本发布后自动提示刷新
- 单个二进制部署，前端资源已内嵌，也提供 Docker 镜像构建

## 兼容范围

| 平台 | 最低版本 |
|---|---|
| iOS / iPadOS Safari | 10.3（iPhone 5、iPad 4 及以后） |
| Android | 5.0（系统 WebView 或 Chrome 49+） |
| 桌面浏览器 | Chrome 49+、Firefox 52+、Safari 10.1+、Edge 16+ |

旧浏览器会自动加载转译到 ES5 的版本（`@vitejs/plugin-legacy`），新浏览器加载现代版本。

## 结构

```
server/                Go 后端：登录会话、Subsonic 代理、MP3 转码缓存（支持 Range）、封面缩略图与模糊背景
  internal/api/        HTTP 路由与接口、歌词、服务器设置
  internal/auth/       会话 Cookie 加密
  internal/cache/      内存缓存
  internal/config/     命令行参数与环境变量
  internal/media/      转码缓存、封面缩略图
  internal/subsonic/   Subsonic API 客户端
  webui/               内嵌前端产物（embed）
web/                   Preact 前端，构建产物输出到 server/webui/dist 并打包进 Go 二进制
deploy/                docker-compose 与环境变量模板
docs/                  Navidrome v0.61.2 API 速查
Dockerfile             多阶段构建：前端 → 后端 → alpine 运行镜像
```

## 环境要求

- Go 1.26+
- Node.js 20+（推荐 22）
- 一台可访问的 Navidrome 服务器（v0.61.2 下测试），且其所在机器安装了 ffmpeg

## 构建

```bash
cd web && npm install && npm run build
cd ../server && go build -o simplemusic .
```

必须先构建前端，Go 编译时会把 `server/webui/dist` 打包进二进制。

交叉编译到树莓派、NAS 等设备：`GOOS=linux GOARCH=arm64 go build -o simplemusic .`

## 运行

```bash
./simplemusic -listen :8080
```

首次打开页面会先进入“连接服务器”：填写 Navidrome 地址并测试连接，保存后再用 Navidrome 账号登录。

地址只保存在当前浏览器（`localStorage`），登录后也记在该浏览器的会话 Cookie 里；服务端不保存，不同浏览器可以连不同的 Navidrome。换浏览器或清除浏览器数据后需要重新填写。
- 登录页的“更换”、侧边栏或页面底部的“服务器设置”都可以修改，只影响当前浏览器；更换后需要重新登录，播放队列会清空；
- 启动时指定了 `-navidrome` 则以参数为准，页面中不可修改，所有浏览器都连这一台，适合 Docker 等固定部署，也能避免本服务被拿去代理任意 Subsonic 服务器。

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `-navidrome` | `SM_NAVIDROME_URL` | 空 | Navidrome 地址；留空则在页面中设置 |
| `-listen` | `SM_LISTEN` | `:8080` | 监听地址 |
| `-data` | `SM_DATA_DIR` | `./data` | 缓存与会话密钥目录 |
| `-bitrate` | `SM_MAX_BITRATE` | `192` | 转码码率上限（kbps） |
| `-cache-mb` | `SM_CACHE_MB` | `2048` | 音频缓存上限（MB），超出后按最久未播放清理 |
| `-secret` | `SM_SECRET` | 自动生成 | 会话加密密钥 |

Navidrome 所在机器需要安装 ffmpeg，否则 FLAC 等格式无法转成 MP3，旧版 Safari 会播放失败。

## Docker 部署

```bash
cd deploy
cp .env.example .env                          # 按需修改端口、Navidrome 地址等
mkdir -p data && sudo chown 1000:1000 data    # 容器以 uid 1000 运行，需能写入
docker compose up -d --build
```

访问 `http://主机IP:9003`（端口由 `.env` 中的 `SM_PORT` 决定）。全部数据在 `deploy/data`（`secret.key`、`audio/`、`covers/`），备份复制该目录即可。

- 基础镜像默认从 DaoCloud 加速站拉取，故障时修改 `.env` 中的 `SM_REGISTRY`；已配置 `registry-mirrors` 可填 `library`。
- Navidrome 跑在宿主机上时，可填 `http://host.docker.internal:4533`。

## 开发

```bash
cd server && go run .
cd web && npm run dev      # http://localhost:5173，/api 自动代理到 :8080
```

后端测试：`cd server && go test ./...`

## 缓存

| 内容 | 位置 | 有效期 |
|---|---|---|
| 专辑、艺人、歌单列表与详情、搜索结果 | Go 内存（按用户） | 10 分钟；最近播放 / 最常播放 1 分钟；搜索 2 分钟；收藏后立即失效；随机列表不缓存 |
| 同上 | 浏览器内存 | 3 分钟；收藏、退出、更换服务器时清空 |
| 封面缩略图、模糊背景 | `data/covers` 磁盘 | 永久 |
| 转码后的 MP3 | `data/audio` 磁盘 | 超过 `-cache-mb` 后按最久未播放清理 |

列表里的封面只在滚动到附近时才加载。接口耗时超过 1 秒会在后端日志中打印“慢请求”。

## 添加到主屏幕（PWA）

| 系统 | 主屏幕图标、全屏打开 | 离线启动、页面外壳缓存 |
|---|---|---|
| iOS 10.3 – 11.2 | Safari“分享 → 添加到主屏幕” | 不支持 |
| iOS 11.3+ | 同上 | 支持 |
| Android 5+ Chrome | 浏览器菜单“安装应用”或“添加到主屏幕” | 支持 |

- Service Worker 和 Android 的安装提示要求 HTTPS（`localhost` 除外）；HTTP 下 iOS 仍可添加到主屏幕。
- Service Worker 只缓存页面外壳，接口、封面、音频不经过它。
- 每次 `npm run build` 都会生成新的 `version.json`。页面每 5 分钟、以及从后台切回前台时检查一次：没在播放时直接刷新，正在播放时顶部提示“有新版本”，由用户决定何时刷新。
- 从主屏幕打开的应用和 Safari 不共享登录状态，第一次需要重新登录；iOS 15.4 以前从主屏幕打开时，锁屏后可能会暂停播放。

## 已知限制

- 第一次播放某首歌时，后端要等转码完成才开始返回（通常几秒）；播放当前歌曲时会预先转码下一首。
- 锁屏和通知栏控制依赖 Media Session API，旧系统上只有基础的后台播放。
- “锁屏显示歌词”（播放页右上角封面菜单里）同样依赖 Media Session，只对有时间轴的歌词生效；系统不支持时不显示该开关（iOS 15 以下、安卓 Chrome 57 以下等）。
- 旧版 iOS 锁屏后能否自动切到下一首取决于系统，iOS 10/11 基本可用，但不保证。

## 许可证

[MIT](LICENSE)
