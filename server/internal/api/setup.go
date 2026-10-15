package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"simplemusic/internal/subsonic"
)

// setupStatus 只告诉前端地址是否被启动参数锁定；未锁定时地址由浏览器自己保存。
func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]any{
		"locked": s.fixedURL != "",
		"url":    s.fixedURL,
	})
}

func (s *Server) setupTest(w http.ResponseWriter, r *http.Request) {
	if s.fixedURL != "" {
		writeError(w, r, http.StatusForbidden, "服务器地址由启动参数指定，不能在页面中修改")
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, r, http.StatusBadRequest, "请求格式错误")
		return
	}
	u, err := subsonic.NormalizeURL(body.URL)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	info, err := subsonic.Probe(r.Context(), u)
	if err != nil {
		writeError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"url": u, "server": info})
}

// isAdmin 查询当前用户是否为管理员；Navidrome 会忽略 username 的值，但缺少这个参数会报错。
func (s *Server) isAdmin(ctx context.Context, a subsonic.Auth) (bool, error) {
	var out struct {
		User subsonic.User `json:"user"`
	}
	if err := s.nd.Call(ctx, a, "getUser", url.Values{"username": {a.User}}, &out); err != nil {
		return false, err
	}
	return out.User.AdminRole, nil
}
