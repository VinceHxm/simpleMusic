# Navidrome v0.61.2 API 速查（面向兼容性播放器）

来源：
- 发布说明：https://github.com/navidrome/navidrome/releases/tag/v0.61.2 （2026-04-12）
- 官方兼容表：https://www.navidrome.org/docs/developers/subsonic-api/
- Subsonic 协议：http://www.subsonic.org/pages/api.jsp （v1.16.1）
- OpenSubsonic 扩展：https://opensubsonic.netlify.app/
- 源码核对（tag v0.61.2）：`server/subsonic/api.go`、`server/subsonic/middlewares.go`、`server/middlewares.go`、`server/subsonic/stream.go`、`server/subsonic/opensubsonic.go`

## 1. 版本概况

- 兼容 Subsonic API **v1.16.1** + OpenSubsonic 扩展。
- v0.61.2 中与 API 相关的变化只有一条：`AlbumID3` 响应**始终**带 `created` 字段（#5340）。
- 其它与播放器相关的变化：WAV 在浏览器中直接播放不再转码（#5309）；转码时声道数按编码器上限截断（#5345）。
- Navidrome 另有一套 `/api/*` 原生 REST 接口（给自带 Web UI 用），**无文档、不保证稳定**，第三方客户端应只用 `/rest/*`（Subsonic）。

## 2. 调用约定

基础地址：`http(s)://<host>:4533/rest/<方法名>`（`/rest/<方法名>.view` 同样可用）。GET 和 POST 表单都可以（`formPost` 扩展）。

公共参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `u` | 是 | 用户名 |
| `t` + `s` | 二选一 | `t = md5(密码 + s)`，`s` 为随机盐（推荐） |
| `p` | 二选一 | 明文密码或 `enc:<十六进制>`（不推荐，会出现在 URL 里） |
| `v` | 是 | 客户端声明的协议版本，填 `1.16.1` |
| `c` | 是 | 客户端名，如 `simpleMusic` |
| `f` | 否 | `xml`（默认）/ `json` / `jsonp`（配合 `callback=函数名`） |

认证逻辑（`validateCredentials`）：优先级 `jwt` > `p` > `t`。服务端以明文形式保存密码，所以 token 认证可用。

CORS（`server/middlewares.go` 中的 `corsHandler`）：`AllowedOrigins: *`、`AllowedHeaders: *`、`AllowCredentials: false`。也就是说，任意域名下的网页都可以直接用 XHR 调用 `/rest/*`，不需要代理。

响应外壳（`f=json`）：

```json
{
  "subsonic-response": {
    "status": "ok",
    "version": "1.16.1",
    "type": "navidrome",
    "serverVersion": "0.61.2 (...)",
    "openSubsonic": true
  }
}
```

失败时 `status: "failed"`，并带 `error: { code, message }`。常见错误码：`0` 通用错误，`10` 缺少参数，`40` 用户名或密码错误，`41` 不支持 token 认证（LDAP 等场景），`50` 无权限，`70` 资源不存在。注意：业务错误时 HTTP 状态码通常仍是 200，要判断 `status` 字段。

## 3. 播放器 MVP 用到的接口

| 用途 | 方法 | 关键参数 |
|---|---|---|
| 登录校验 | `ping` | 只有公共参数 |
| 能力探测 | `getOpenSubsonicExtensions` | 无（返回 `transcodeOffset`、`formPost`、`songLyrics`、`indexBasedQueue`、`transcoding`） |
| 专辑列表 | `getAlbumList2` | `type`=`newest`/`random`/`recent`/`frequent`/`starred`/`alphabeticalByName`/`alphabeticalByArtist`/`byYear`（配 `fromYear`、`toYear`）/`byGenre`（配 `genre`）；`size`（最大 500）；`offset` |
| 专辑详情和曲目 | `getAlbum` | `id` |
| 艺人列表 | `getArtists` | 可选 `musicFolderId` |
| 艺人的专辑 | `getArtist` | `id` |
| 歌单 | `getPlaylists` / `getPlaylist` | `getPlaylist` 需要 `id` |
| 搜索 | `search3` | `query`、`artistCount`、`albumCount`、`songCount`，以及对应的 `*Offset`；只支持简单前缀匹配，不支持 Lucene 语法 |
| 随机播放 | `getRandomSongs` | `size`、`genre`、`fromYear`、`toYear` |
| 收藏 | `getStarred2` / `star` / `unstar` | `id` / `albumId` / `artistId` |
| 封面 | `getCoverArt` | `id`（取自歌曲或专辑的 `coverArt` 字段）、`size`（像素，旧设备建议 150～300） |
| 播放音频 | `stream` | 见第 4 节 |
| 播放记录 | `scrobble` | `id`、`submission=true`；**只调用 `stream` 不会计入播放次数** |
| 歌词 | `getLyricsBySongId`（OpenSubsonic）/ `getLyrics` | `id` / `artist` + `title` |
| 跨设备续播 | `getPlayQueue` / `savePlayQueue` | `current` 是字符串 id，不是整数 |

ID 一律是字符串（MD5 或 UUID），不要转成数字。

## 4. `stream`：旧设备兼容的关键

从源码读取的参数：`id`、`maxBitRate`、`format`、`timeOffset`。

```
/rest/stream?id=<songId>&format=mp3&maxBitRate=128&u=..&t=..&s=..&v=1.16.1&c=simpleMusic
```

- `format=mp3`：服务端用 ffmpeg 转成 MP3。iOS 11 以前的 Safari 不支持 FLAC，各版本 Safari 都不支持 Ogg/Opus，老安卓的支持情况也参差不齐，统一转成 MP3 兼容性最好（需要服务器装有 ffmpeg）。
- `format=raw`：强制不转码，原样输出。
- `maxBitRate`：码率上限（kbps），弱网或老设备建议 128～192。
- `timeOffset`（`transcodeOffset` 扩展）：从第 N 秒开始转码。转码流通常没有准确的 `Content-Length`，也不支持 Range 请求，拖动进度条的做法是用新的 `timeOffset` 重新请求，前端自己记录播放进度的偏移量。
- 响应头会通过 CORS 暴露 `x-content-duration`，可以在转码流中读到总时长。
- `download`：原始文件下载，不做转码。
- v0.61.2 新增的 `getTranscodeDecision` / `getTranscodeStream`（`transcoding` 扩展）面向现代客户端的能力协商；旧设备场景直接用 `stream?format=mp3` 更简单。

## 5. 不支持或不可用的接口

- 播客：`getPodcasts` 等返回 501。
- 用户管理：`createUser` / `updateUser` / `deleteUser` / `changePassword` 返回 501。
- 视频、聊天、旧版 `search`：返回 410。
- `getShares` 等分享接口需要开启 `EnableSharing`，`jukeboxControl` 需要开启 `Jukebox.Enabled`，否则返回 501。
- `getTopSongs` / `getSimilarSongs*` / `get*Info*` 依赖 Last.fm 等外部集成。
- 按目录浏览（`getIndexes` / `getMusicDirectory`）返回的是模拟出来的 `/艺人/专辑/曲目` 结构。
