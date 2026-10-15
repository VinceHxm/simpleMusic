package api

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"simplemusic/internal/auth"
	"simplemusic/internal/media"
	"simplemusic/internal/subsonic"
)

const testPassword = "secret"

var albumListCalls int32

// fakeNavidrome 模拟 Navidrome 的 Subsonic 接口；stream 故意不支持 Range，与真实转码流一致。
func fakeNavidrome(t *testing.T, streamCalls *int32) *httptest.Server {
	audio := bytes.Repeat([]byte("ID3fakeaudio"), 2000)
	ok := func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome"%s}}`, body)
	}
	fail := func(w http.ResponseWriter, code int, msg string) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"subsonic-response":{"status":"failed","version":"1.16.1","type":"navidrome","error":{"code":%d,"message":%q}}}`, code, msg)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("u") == "" {
			fail(w, 10, "Required parameter 'u' is missing")
			return
		}
		sum := md5.Sum([]byte(testPassword + q.Get("s")))
		if q.Get("t") != hex.EncodeToString(sum[:]) {
			fail(w, 40, "Wrong username or password")
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/rest/") {
		case "ping":
			ok(w, "")
		case "getUser":
			if q.Get("username") == "" {
				fail(w, 10, "missing parameter: 'username'")
				return
			}
			ok(w, fmt.Sprintf(`,"user":{"username":%q,"adminRole":%t}`, q.Get("u"), q.Get("u") == "admin"))
		case "getAlbumList2":
			atomic.AddInt32(&albumListCalls, 1)
			if q.Get("type") != "newest" {
				t.Errorf("unexpected album list type %q", q.Get("type"))
			}
			ok(w, `,"albumList2":{"album":[{"id":"al-1","name":"测试专辑","artist":"测试艺人","coverArt":"al-1","songCount":1,"created":"2026-01-01T00:00:00Z"}]}`)
		case "getAlbum":
			if q.Get("id") != "al-1" {
				fail(w, 70, "Album not found")
				return
			}
			ok(w, `,"album":{"id":"al-1","name":"测试专辑","song":[{"id":"so-1","title":"第一首","duration":200,"suffix":"flac"}]}`)
		case "stream":
			atomic.AddInt32(streamCalls, 1)
			if q.Get("format") != "mp3" {
				t.Errorf("stream should request mp3, got %q", q.Get("format"))
			}
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write(audio)
		case "star", "unstar":
			ok(w, "")
		case "getLyricsBySongId":
			if q.Get("id") != "so-1" {
				ok(w, `,"lyricsList":{}`)
				return
			}
			ok(w, `,"lyricsList":{"structuredLyrics":[
				{"lang":"xxx","synced":false,"line":[{"value":"纯文本"}]},
				{"lang":"xxx","synced":true,"offset":500,"line":[
					{"start":0,"value":""},{"start":1000,"value":"Hello"},{"start":1000,"value":"你好"},{"start":3000,"value":"World"}]}]}`)
		case "getLyrics":
			if q.Get("title") != "第二首" || q.Get("artist") != "测试艺人" {
				ok(w, `,"lyrics":{}`)
				return
			}
			ok(w, `,"lyrics":{"artist":"测试艺人","title":"第二首","value":"[ti:第二首]\r\n[offset:-200]\r\n[00:05.5][00:01.20]副歌\r\n[00:03.00]主歌\r\n"}`)
		case "getCoverArt":
			img := image.NewRGBA(image.Rect(0, 0, 150, 150))
			for x := 0; x < 150; x++ {
				for y := 0; y < 150; y++ {
					img.Set(x, y, color.RGBA{uint8(x), uint8(y), 200, 255})
				}
			}
			w.Header().Set("Content-Type", "image/png")
			_ = png.Encode(w, img)
		default:
			fail(w, 70, "not found")
		}
	}))
}

type testEnv struct {
	srv    *httptest.Server
	client *http.Client
	nd     *httptest.Server
	ndURL  string
}

// newTestEnv 启动一套测试环境；fixed 为 true 时模拟启动参数指定了地址，否则地址由各浏览器登录时提交。
func newTestEnv(t *testing.T, streamCalls *int32, fixed bool) *testEnv {
	nd := fakeNavidrome(t, streamCalls)
	t.Cleanup(nd.Close)

	dir := t.TempDir()
	fixedURL := ""
	if fixed {
		fixedURL = nd.URL
	}
	client := subsonic.NewClient()
	sess, err := auth.NewManager("test-secret", 3600e9)
	if err != nil {
		t.Fatal(err)
	}
	streams, err := media.NewStreamCache(dir+"/audio", 100, 192, client)
	if err != nil {
		t.Fatal(err)
	}
	images, err := media.NewImages(dir+"/covers", client)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(client, fixedURL, sess, streams, images).Handler(http.NotFoundHandler()))
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	return &testEnv{srv: srv, client: &http.Client{Jar: jar}, nd: nd, ndURL: nd.URL}
}

func newTestServer(t *testing.T, streamCalls *int32) (*httptest.Server, *http.Client) {
	env := newTestEnv(t, streamCalls, true)
	return env.srv, env.client
}

func login(t *testing.T, c *http.Client, base, password string) int {
	return loginAs(t, c, base, "admin", password)
}

func loginAs(t *testing.T, c *http.Client, base, user, password string) int {
	return loginTo(t, c, base, "", user, password)
}

func loginTo(t *testing.T, c *http.Client, base, server, user, password string) int {
	body, _ := json.Marshal(map[string]string{"url": server, "username": user, "password": password})
	resp, err := c.Post(base+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestLoginAndBrowse(t *testing.T) {
	var calls int32
	srv, c := newTestServer(t, &calls)

	if code := getStatus(t, c, srv.URL+"/api/albums"); code != http.StatusUnauthorized {
		t.Fatalf("未登录应返回 401，实际 %d", code)
	}
	if code := login(t, c, srv.URL, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("错误密码应返回 401，实际 %d", code)
	}
	if code := login(t, c, srv.URL, testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}

	var me struct {
		Username string `json:"username"`
		Admin    bool   `json:"admin"`
	}
	getJSON(t, c, srv.URL+"/api/me", &me)
	if me.Username != "admin" || !me.Admin {
		t.Fatalf("/api/me 不符合预期：%+v", me)
	}

	var list struct {
		Albums []subsonic.Album `json:"albums"`
	}
	getJSON(t, c, srv.URL+"/api/albums?type=bogus", &list)
	if len(list.Albums) != 1 || list.Albums[0].Name != "测试专辑" {
		t.Fatalf("专辑列表不符合预期：%+v", list)
	}

	var album subsonic.Album
	getJSON(t, c, srv.URL+"/api/albums/al-1", &album)
	if len(album.Song) != 1 || album.Song[0].ID != "so-1" {
		t.Fatalf("专辑详情不符合预期：%+v", album)
	}

	if code := getStatus(t, c, srv.URL+"/api/albums/missing"); code != http.StatusNotFound {
		t.Fatalf("不存在的专辑应返回 404，实际 %d", code)
	}
}

func TestListCacheAndInvalidation(t *testing.T) {
	var calls int32
	srv, c := newTestServer(t, &calls)
	if code := login(t, c, srv.URL, testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}
	atomic.StoreInt32(&albumListCalls, 0)
	var list map[string]any
	getJSON(t, c, srv.URL+"/api/albums?type=newest", &list)
	getJSON(t, c, srv.URL+"/api/albums?type=newest", &list)
	if n := atomic.LoadInt32(&albumListCalls); n != 1 {
		t.Fatalf("第二次请求应命中缓存，实际请求 Navidrome %d 次", n)
	}
	resp, err := c.Post(srv.URL+"/api/star/al-1?kind=album", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	getJSON(t, c, srv.URL+"/api/albums?type=newest", &list)
	if n := atomic.LoadInt32(&albumListCalls); n != 2 {
		t.Fatalf("收藏后缓存应失效，实际请求 Navidrome %d 次", n)
	}
}

func TestStreamSupportsRangeAndCaches(t *testing.T) {
	var calls int32
	srv, c := newTestServer(t, &calls)
	if code := login(t, c, srv.URL, testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}

	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/stream/so-1", nil)
		req.Header.Set("Range", "bytes=0-1")
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusPartialContent || string(body) != "ID" {
			t.Fatalf("Range 请求应返回 206 和 2 个字节，实际 %d %q", resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "audio/mpeg" {
			t.Fatalf("Content-Type 应为 audio/mpeg，实际 %q", ct)
		}
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("同一首歌应只转码一次，实际 %d 次", n)
	}
}

func TestBlurCover(t *testing.T) {
	var calls int32
	srv, c := newTestServer(t, &calls)
	if code := login(t, c, srv.URL, testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}
	resp, err := c.Get(srv.URL + "/api/cover/al-1/blur")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	img, format, err := image.Decode(resp.Body)
	if err != nil {
		t.Fatalf("模糊封面无法解码：%v", err)
	}
	if format != "jpeg" || img.Bounds().Dx() != 48 {
		t.Fatalf("模糊封面应为 48px 宽的 JPEG，实际 %s %dpx", format, img.Bounds().Dx())
	}
}

func TestLyrics(t *testing.T) {
	var calls int32
	srv, c := newTestServer(t, &calls)
	if code := login(t, c, srv.URL, testPassword); code != http.StatusOK {
		t.Fatalf("登录失败：%d", code)
	}
	format := func(l Lyrics) string {
		var b strings.Builder
		fmt.Fprintf(&b, "synced=%t", l.Synced)
		for _, line := range l.Lines {
			b.WriteString("|")
			if line.Time != nil {
				fmt.Fprintf(&b, "%d ", *line.Time)
			}
			b.WriteString(line.Text)
			if line.Trans != "" {
				b.WriteString("/" + line.Trans)
			}
		}
		return b.String()
	}
	cases := []struct{ url, want string }{
		{"/api/lyrics/so-1", "synced=true|500 Hello/你好|2500 World"},
		{"/api/lyrics/so-2?artist=" + "%E6%B5%8B%E8%AF%95%E8%89%BA%E4%BA%BA" + "&title=%E7%AC%AC%E4%BA%8C%E9%A6%96", "synced=true|1400 副歌|3200 主歌|5700 副歌"},
		{"/api/lyrics/so-3?title=none", "synced=false"},
	}
	for _, tc := range cases {
		var got Lyrics
		getJSON(t, c, srv.URL+tc.url, &got)
		if s := format(got); s != tc.want {
			t.Errorf("GET %s\n  实际 %s\n  期望 %s", tc.url, s, tc.want)
		}
	}
}

func TestParseLRCPlainText(t *testing.T) {
	l := parseLRC("\n[ar:某人]\n第一行\n\n第二行\n")
	if l.Synced || len(l.Lines) != 3 || l.Lines[0].Text != "第一行" || l.Lines[2].Text != "第二行" {
		t.Fatalf("纯文本歌词解析不符合预期：%+v", l)
	}
}

func getStatus(t *testing.T, c *http.Client, url string) int {
	resp, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func getJSON(t *testing.T, c *http.Client, url string, out any) {
	resp, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s 返回 %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}
