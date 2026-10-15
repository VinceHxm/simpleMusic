package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"simplemusic/internal/subsonic"
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, r, http.StatusBadRequest, "请求格式错误")
		return
	}
	server := s.fixedURL
	if server == "" {
		if strings.TrimSpace(body.URL) == "" {
			writeError(w, r, http.StatusConflict, "请先设置服务器地址")
			return
		}
		u, err := subsonic.NormalizeURL(body.URL)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, err.Error())
			return
		}
		server = u
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		writeError(w, r, http.StatusBadRequest, "请输入用户名和密码")
		return
	}
	a := subsonic.NewAuth(server, body.Username, body.Password)
	if err := s.nd.Call(r.Context(), a, "ping", nil, nil); err != nil {
		var se *subsonic.Error
		if errors.As(err, &se) && se.Code == subsonic.ErrCodeAuth {
			writeError(w, r, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		s.fail(w, r, err)
		return
	}
	if err := s.sess.Set(w, r, a); err != nil {
		writeError(w, r, http.StatusInternalServerError, "创建会话失败")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]string{"username": a.User, "server": server})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.sess.Clear(w)
	writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	admin, err := s.isAdmin(r.Context(), a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"username": a.User, "admin": admin, "server": a.Server})
}

const (
	listTTL   = 10 * time.Minute
	recentTTL = time.Minute
	searchTTL = 2 * time.Minute
)

// 值为该类型列表的缓存时间；随机列表每次都要换一批，不缓存。
var albumListTypes = map[string]time.Duration{
	"newest": listTTL, "recent": recentTTL, "frequent": recentTTL, "random": 0,
	"starred": listTTL, "alphabeticalByName": listTTL, "alphabeticalByArtist": listTTL, "highest": listTTL,
}

func (s *Server) albums(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	typ := r.URL.Query().Get("type")
	ttl, ok := albumListTypes[typ]
	if !ok {
		typ, ttl = "newest", listTTL
	}
	q := url.Values{}
	q.Set("type", typ)
	q.Set("size", strconv.Itoa(intParam(r, "size", 40, 1, 100)))
	q.Set("offset", strconv.Itoa(intParam(r, "offset", 0, 0, 1<<30)))
	var out struct {
		AlbumList2 struct {
			Album []subsonic.Album `json:"album"`
		} `json:"albumList2"`
	}
	var err error
	if ttl > 0 {
		err = s.cached(r.Context(), a, "getAlbumList2", q, ttl, &out)
	} else {
		err = s.nd.Call(r.Context(), a, "getAlbumList2", q, &out)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"albums": nonNil(out.AlbumList2.Album)})
}

func (s *Server) album(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	var out struct {
		Album subsonic.Album `json:"album"`
	}
	if err := s.cached(r.Context(), a, "getAlbum", url.Values{"id": {r.PathValue("id")}}, listTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, out.Album)
}

func (s *Server) artists(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	var out struct {
		Artists struct {
			Index []subsonic.ArtistIndex `json:"index"`
		} `json:"artists"`
	}
	if err := s.cached(r.Context(), a, "getArtists", url.Values{}, listTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"indexes": nonNil(out.Artists.Index)})
}

func (s *Server) artist(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	var out struct {
		Artist subsonic.Artist `json:"artist"`
	}
	if err := s.cached(r.Context(), a, "getArtist", url.Values{"id": {r.PathValue("id")}}, listTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, out.Artist)
}

func (s *Server) playlists(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	var out struct {
		Playlists struct {
			Playlist []subsonic.Playlist `json:"playlist"`
		} `json:"playlists"`
	}
	if err := s.cached(r.Context(), a, "getPlaylists", url.Values{}, listTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"playlists": nonNil(out.Playlists.Playlist)})
}

func (s *Server) playlist(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	var out struct {
		Playlist subsonic.Playlist `json:"playlist"`
	}
	if err := s.cached(r.Context(), a, "getPlaylist", url.Values{"id": {r.PathValue("id")}}, listTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, out.Playlist)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, r, http.StatusOK, subsonic.SearchResult{Artist: []subsonic.Artist{}, Album: []subsonic.Album{}, Song: []subsonic.Song{}})
		return
	}
	q := url.Values{}
	q.Set("query", query)
	q.Set("artistCount", "8")
	q.Set("albumCount", "12")
	q.Set("songCount", "40")
	var out struct {
		SearchResult3 subsonic.SearchResult `json:"searchResult3"`
	}
	if err := s.cached(r.Context(), a, "search3", q, searchTTL, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	res := out.SearchResult3
	writeJSON(w, r, http.StatusOK, subsonic.SearchResult{Artist: nonNil(res.Artist), Album: nonNil(res.Album), Song: nonNil(res.Song)})
}

func (s *Server) random(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	q := url.Values{}
	q.Set("size", strconv.Itoa(intParam(r, "size", 50, 1, 200)))
	var out struct {
		RandomSongs struct {
			Song []subsonic.Song `json:"song"`
		} `json:"randomSongs"`
	}
	if err := s.nd.Call(r.Context(), a, "getRandomSongs", q, &out); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"songs": nonNil(out.RandomSongs.Song)})
}

func (s *Server) star(on bool) authedFunc {
	method := "unstar"
	if on {
		method = "star"
	}
	return func(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
		key := "id"
		switch r.URL.Query().Get("kind") {
		case "album":
			key = "albumId"
		case "artist":
			key = "artistId"
		}
		if err := s.nd.Call(r.Context(), a, method, url.Values{key: {r.PathValue("id")}}, nil); err != nil {
			s.fail(w, r, err)
			return
		}
		s.invalidate(a)
		writeJSON(w, r, http.StatusOK, map[string]bool{"starred": on})
	}
}

func (s *Server) scrobble(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	q := url.Values{}
	q.Set("id", r.PathValue("id"))
	q.Set("submission", strconv.FormatBool(r.URL.Query().Get("submission") == "true"))
	if err := s.nd.Call(r.Context(), a, "scrobble", q, nil); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	p, err := s.streams.Ensure(a, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	serveFile(w, r, p, "audio/mpeg")
}

// prefetch 让前端在当前歌曲播放时提前转码下一首，切歌时不用再等。
func (s *Server) prefetch(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	id := r.PathValue("id")
	go func() { _, _ = s.streams.Ensure(a, id) }()
	writeJSON(w, r, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) cover(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	p, err := s.images.Cover(a, r.PathValue("id"), intParam(r, "size", 300, 32, 1200))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	serveFile(w, r, p, "")
}

func (s *Server) coverBlur(w http.ResponseWriter, r *http.Request, a subsonic.Auth) {
	p, err := s.images.Blur(a, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	serveFile(w, r, p, "image/jpeg")
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
