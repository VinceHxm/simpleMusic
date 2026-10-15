package api

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"simplemusic/internal/auth"
	"simplemusic/internal/cache"
	"simplemusic/internal/media"
	"simplemusic/internal/subsonic"
)

// Server 不保存 Navidrome 地址：地址由各浏览器自己记住，登录后存在会话里。
// fixedURL 非空表示启动参数指定了地址，所有人只能用这一台服务器。
type Server struct {
	nd       *subsonic.Client
	fixedURL string
	sess     *auth.Manager
	streams  *media.StreamCache
	images   *media.Images
	cache    *cache.TTL
}

func New(nd *subsonic.Client, fixedURL string, sess *auth.Manager, streams *media.StreamCache, images *media.Images) *Server {
	return &Server{nd: nd, fixedURL: fixedURL, sess: sess, streams: streams, images: images, cache: cache.New(2000)}
}

func (s *Server) userPrefix(a subsonic.Auth) string {
	return a.Server + "|" + a.User + "|"
}

// cached 按“服务器 + 用户 + 方法 + 参数”缓存 Navidrome 的响应，各用户的收藏、播放记录互不影响。
func (s *Server) cached(ctx context.Context, a subsonic.Auth, method string, q url.Values, ttl time.Duration, out any) error {
	key := s.userPrefix(a) + method + "?" + q.Encode()
	raw, ok := s.cache.Get(key)
	if !ok {
		var err error
		if raw, err = s.nd.Raw(ctx, a, method, q); err != nil {
			return err
		}
		s.cache.Set(key, raw, ttl)
	}
	return json.Unmarshal(raw, out)
}

// invalidate 在收藏、播放等会改变列表内容的操作后清掉该用户的缓存。
func (s *Server) invalidate(a subsonic.Auth) {
	s.cache.DeletePrefix(s.userPrefix(a))
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// logSlow 记录超过 1 秒的接口请求，方便判断是 Navidrome 慢还是网络慢。
func logSlow(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if d := time.Since(start); d > time.Second {
			log.Printf("慢请求 %s %s -> %d，耗时 %s", r.Method, r.URL.Path, rec.status, d.Round(time.Millisecond))
		}
	})
}

type authedFunc func(w http.ResponseWriter, r *http.Request, a subsonic.Auth)

func (s *Server) Handler(static http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/setup", s.setupStatus)
	mux.HandleFunc("POST /api/setup/test", s.setupTest)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("GET /api/me", s.authed(s.me))

	mux.HandleFunc("GET /api/albums", s.authed(s.albums))
	mux.HandleFunc("GET /api/albums/{id}", s.authed(s.album))
	mux.HandleFunc("GET /api/artists", s.authed(s.artists))
	mux.HandleFunc("GET /api/artists/{id}", s.authed(s.artist))
	mux.HandleFunc("GET /api/playlists", s.authed(s.playlists))
	mux.HandleFunc("GET /api/playlists/{id}", s.authed(s.playlist))
	mux.HandleFunc("GET /api/search", s.authed(s.search))
	mux.HandleFunc("GET /api/random", s.authed(s.random))
	mux.HandleFunc("POST /api/star/{id}", s.authed(s.star(true)))
	mux.HandleFunc("DELETE /api/star/{id}", s.authed(s.star(false)))
	mux.HandleFunc("POST /api/scrobble/{id}", s.authed(s.scrobble))
	mux.HandleFunc("GET /api/lyrics/{id}", s.authed(s.lyrics))

	mux.HandleFunc("GET /api/stream/{id}", s.authed(s.stream))
	mux.HandleFunc("POST /api/prefetch/{id}", s.authed(s.prefetch))
	mux.HandleFunc("GET /api/cover/{id}", s.authed(s.cover))
	mux.HandleFunc("GET /api/cover/{id}/blur", s.authed(s.coverBlur))

	mux.Handle("/", static)
	return logSlow(mux)
}

func (s *Server) authed(h authedFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := s.sess.Get(r)
		if err != nil || (s.fixedURL != "" && a.Server != s.fixedURL) {
			writeError(w, r, http.StatusUnauthorized, "请先登录")
			return
		}
		h(w, r, a)
	}
}

// fail 把 Navidrome 的错误码映射成 HTTP 状态码；密码被改后旧 token 失效，需要清掉会话。
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *subsonic.Error
	if errors.As(err, &se) {
		switch se.Code {
		case subsonic.ErrCodeAuth:
			s.sess.Clear(w)
			writeError(w, r, http.StatusUnauthorized, "登录已失效，请重新登录")
			return
		case subsonic.ErrCodeNotFound:
			writeError(w, r, http.StatusNotFound, "内容不存在")
			return
		}
	}
	log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
	writeError(w, r, http.StatusBadGateway, "音乐服务暂时不可用")
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.WriteHeader(status)
		gz := gzip.NewWriter(w)
		defer gz.Close()
		_ = json.NewEncoder(gz).Encode(v)
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	writeJSON(w, r, status, map[string]string{"error": msg})
}

func serveFile(w http.ResponseWriter, r *http.Request, path, contentType string) {
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "private, max-age=604800")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func intParam(r *http.Request, name string, def, lo, hi int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return def
	}
	return min(max(v, lo), hi)
}
