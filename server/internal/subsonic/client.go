package subsonic

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	apiVersion = "1.16.1"
	clientName = "simpleMusic"

	ErrCodeAuth     = 40
	ErrCodeNotFound = 70
)

// Auth 是 Subsonic 的 token 认证参数，token = md5(密码 + salt)，可重复使用。
// Server 是该凭据所属的 Navidrome 地址，每个浏览器可以连不同的服务器；它由会话单独保存，不参与序列化。
type Auth struct {
	Server string `json:"-"`
	User   string `json:"u"`
	Token  string `json:"t"`
	Salt   string `json:"s"`
}

func NewAuth(server, user, password string) Auth {
	buf := make([]byte, 6)
	_, _ = rand.Read(buf)
	salt := hex.EncodeToString(buf)
	sum := md5.Sum([]byte(password + salt))
	return Auth{Server: server, User: user, Token: hex.EncodeToString(sum[:]), Salt: salt}
}

// NormalizeURL 补全协议、去掉末尾的斜杠和 /rest，只接受 http/https。
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("请输入服务器地址")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", errors.New("服务器地址格式不正确")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("只支持 http 或 https 地址")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.User = nil
	path := strings.TrimRight(u.Path, "/")
	path = strings.TrimSuffix(path, "/rest")
	u.Path = strings.TrimRight(path, "/")
	return u.String(), nil
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("subsonic 错误 %d: %s", e.Code, e.Message) }

// Client 不绑定服务器地址，每次请求使用 Auth.Server，所有服务器共用一个连接池。
type Client struct {
	transport *http.Transport
	http      *http.Client
}

// NewClient 使用共享连接池：默认 Transport 对同一主机只保留 2 条空闲连接，
// 并发加载封面时会反复重建 HTTPS 连接，远程服务器上尤其明显。
func NewClient() *Client {
	t := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &Client{transport: t, http: &http.Client{Transport: t, Timeout: 30 * time.Second}}
}

type ServerInfo struct {
	Type          string `json:"type"`
	ServerVersion string `json:"serverVersion"`
	Version       string `json:"version"`
	OpenSubsonic  bool   `json:"openSubsonic"`
}

// Probe 不带账号调用 ping，只要对方返回合法的 subsonic-response（哪怕是缺少参数的错误），
// 就说明地址指向的是 Navidrome 或兼容 Subsonic 的服务。
func Probe(ctx context.Context, base string) (*ServerInfo, error) {
	q := url.Values{}
	q.Set("f", "json")
	q.Set("v", apiVersion)
	q.Set("c", clientName)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/rest/ping?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接到 %s", base)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var env struct {
		Resp *ServerInfo `json:"subsonic-response"`
	}
	if err := json.Unmarshal(body, &env); err != nil || env.Resp == nil || env.Resp.Version == "" {
		return nil, fmt.Errorf("该地址不是 Navidrome / Subsonic 服务")
	}
	return env.Resp, nil
}

func (c *Client) URL(a Auth, method string, q url.Values) string {
	if q == nil {
		q = url.Values{}
	}
	q.Set("u", a.User)
	q.Set("t", a.Token)
	q.Set("s", a.Salt)
	q.Set("v", apiVersion)
	q.Set("c", clientName)
	return a.Server + "/rest/" + method + "?" + q.Encode()
}

// Call 调用返回 JSON 的接口，并把 subsonic-response 的内容解码到 out。
func (c *Client) Call(ctx context.Context, a Auth, method string, q url.Values, out any) error {
	raw, err := c.Raw(ctx, a, method, q)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// Raw 返回校验过状态的 subsonic-response 内容，供上层缓存后再解码。
func (c *Client) Raw(ctx context.Context, a Auth, method string, q url.Values) (json.RawMessage, error) {
	params := url.Values{}
	for k, v := range q {
		params[k] = v
	}
	params.Set("f", "json")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL(a, method, params), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return unwrap(body)
}

// Fetch 用于 stream、getCoverArt 等返回二进制的接口；出错时 Navidrome 会改为返回 JSON 错误体。
func (c *Client) Fetch(ctx context.Context, a Auth, method string, q url.Values) (*http.Response, error) {
	if q == nil {
		q = url.Values{}
	}
	q.Set("f", "json")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL(a, method, q), nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Transport: c.transport}).Do(req)
	if err != nil {
		return nil, err
	}
	ct := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK || strings.Contains(ct, "json") || strings.Contains(ct, "xml") {
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if _, err := unwrap(body); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("Navidrome 返回异常：HTTP %d %s", resp.StatusCode, ct)
	}
	return resp, nil
}

func unwrap(body []byte) (json.RawMessage, error) {
	var env struct {
		Resp json.RawMessage `json:"subsonic-response"`
	}
	if err := json.Unmarshal(body, &env); err != nil || env.Resp == nil {
		return nil, fmt.Errorf("无法解析 Navidrome 响应")
	}
	var st struct {
		Status string `json:"status"`
		Error  *Error `json:"error"`
	}
	if err := json.Unmarshal(env.Resp, &st); err != nil {
		return nil, err
	}
	if st.Status != "ok" {
		if st.Error != nil {
			return nil, st.Error
		}
		return nil, fmt.Errorf("Navidrome 请求失败")
	}
	return env.Resp, nil
}
