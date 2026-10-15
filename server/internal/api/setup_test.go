package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"simplemusic/internal/subsonic"
)

func postURL(t *testing.T, c *http.Client, endpoint, u string) (int, map[string]any) {
	body, _ := json.Marshal(map[string]string{"url": u})
	resp, err := c.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func setupStatus(t *testing.T, env *testEnv) map[string]any {
	var out map[string]any
	getJSON(t, env.client, env.srv.URL+"/api/setup", &out)
	return out
}

func newJarClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func meServer(t *testing.T, c *http.Client, base string) string {
	var me struct {
		Server string `json:"server"`
	}
	getJSON(t, c, base+"/api/me", &me)
	return me.Server
}

func TestSetupTestEndpoint(t *testing.T) {
	var calls int32
	env := newTestEnv(t, &calls, false)

	if st := setupStatus(t, env); st["locked"] != false || st["url"] != "" {
		t.Fatalf("未指定启动参数时不应锁定、也不应返回地址：%v", st)
	}
	if code := login(t, env.client, env.srv.URL, testPassword); code != http.StatusConflict {
		t.Fatalf("登录未附带地址应返回 409，实际 %d", code)
	}

	notSubsonic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html>hello</html>")
	}))
	defer notSubsonic.Close()
	if code, _ := postURL(t, env.client, env.srv.URL+"/api/setup/test", notSubsonic.URL); code != http.StatusBadGateway {
		t.Fatalf("非 Subsonic 地址测试应失败，实际 %d", code)
	}
	if code, _ := postURL(t, env.client, env.srv.URL+"/api/setup/test", "ftp://example.com"); code != http.StatusBadRequest {
		t.Fatalf("非 http 地址应返回 400，实际 %d", code)
	}
	code, out := postURL(t, env.client, env.srv.URL+"/api/setup/test", env.ndURL+"/rest/")
	if code != http.StatusOK || out["url"] != env.ndURL {
		t.Fatalf("测试地址应成功并返回规范化地址：%d %v", code, out)
	}
	if code := loginTo(t, env.client, env.srv.URL, env.ndURL+"/rest/", "admin", testPassword); code != http.StatusOK {
		t.Fatalf("附带地址登录失败：%d", code)
	}
	if s := meServer(t, env.client, env.srv.URL); s != env.ndURL {
		t.Fatalf("会话中的服务器地址应为规范化后的地址，实际 %q", s)
	}
}

// 两个浏览器各自连不同的服务器，互不影响；同一个歌曲 ID 的音频缓存也要分开。
func TestServerIsPerBrowser(t *testing.T) {
	var callsA, callsB int32
	env := newTestEnv(t, &callsA, false)
	other := fakeNavidrome(t, &callsB)
	defer other.Close()

	a, b := env.client, newJarClient()
	if code := loginTo(t, a, env.srv.URL, env.ndURL, "admin", testPassword); code != http.StatusOK {
		t.Fatalf("浏览器 A 登录失败：%d", code)
	}
	if code := loginTo(t, b, env.srv.URL, other.URL, "guest", testPassword); code != http.StatusOK {
		t.Fatalf("浏览器 B 登录失败：%d", code)
	}
	if s := meServer(t, a, env.srv.URL); s != env.ndURL {
		t.Fatalf("浏览器 A 的服务器被改动：%q", s)
	}
	if s := meServer(t, b, env.srv.URL); s != other.URL {
		t.Fatalf("浏览器 B 的服务器不正确：%q", s)
	}

	var list struct {
		Albums []subsonic.Album `json:"albums"`
	}
	getJSON(t, a, env.srv.URL+"/api/albums", &list)
	getJSON(t, b, env.srv.URL+"/api/albums", &list)
	if code := getStatus(t, a, env.srv.URL+"/api/stream/so-1"); code != http.StatusOK {
		t.Fatalf("浏览器 A 播放失败：%d", code)
	}
	if code := getStatus(t, b, env.srv.URL+"/api/stream/so-1"); code != http.StatusOK {
		t.Fatalf("浏览器 B 播放失败：%d", code)
	}
	if atomic.LoadInt32(&callsA) != 1 || atomic.LoadInt32(&callsB) != 1 {
		t.Fatalf("不同服务器的同 ID 歌曲应各自转码一次，实际 A=%d B=%d", callsA, callsB)
	}
}

func TestLockedByFlag(t *testing.T) {
	var calls int32
	env := newTestEnv(t, &calls, true)
	other := fakeNavidrome(t, &calls)
	defer other.Close()

	if st := setupStatus(t, env); st["locked"] != true || st["url"] != env.ndURL {
		t.Fatalf("启动参数指定地址时应锁定并返回该地址：%v", st)
	}
	if code, _ := postURL(t, env.client, env.srv.URL+"/api/setup/test", other.URL); code != http.StatusForbidden {
		t.Fatalf("锁定后不应允许测试其它地址，实际 %d", code)
	}
	if code := loginTo(t, env.client, env.srv.URL, other.URL, "admin", testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}
	if s := meServer(t, env.client, env.srv.URL); s != env.ndURL {
		t.Fatalf("锁定后应忽略前端提交的地址，实际 %q", s)
	}

	// 未锁定实例签发的、指向其它服务器的会话，在锁定实例上不能使用。
	free := newTestEnv(t, &calls, false)
	c := newJarClient()
	if code := loginTo(t, c, free.srv.URL, other.URL, "admin", testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}
	if code := getStatus(t, c, free.srv.URL+"/api/me"); code != http.StatusOK {
		t.Fatalf("会话应有效，实际 %d", code)
	}
	// Cookie 不区分端口，同一个客户端会把它带到锁定实例上。
	if code := getStatus(t, c, env.srv.URL+"/api/albums"); code != http.StatusUnauthorized {
		t.Fatalf("指向其它服务器的会话在锁定实例上应返回 401，实际 %d", code)
	}
}
