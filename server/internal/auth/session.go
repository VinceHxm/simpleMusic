package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"simplemusic/internal/subsonic"
)

const cookieName = "sm_session"

type payload struct {
	subsonic.Auth
	Server string `json:"sv"`
	Exp    int64  `json:"e"`
}

// Manager 把 Navidrome 的 token 认证参数加密后放进 Cookie，服务端无需保存会话，重启也不会掉登录。
type Manager struct {
	aead cipher.AEAD
	ttl  time.Duration
}

func NewManager(secret string, ttl time.Duration) (*Manager, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Manager{aead: aead, ttl: ttl}, nil
}

// Set 把凭据和所属的服务器地址一起加密写入 Cookie，每个浏览器的会话各自记住连的是哪台服务器。
func (m *Manager) Set(w http.ResponseWriter, r *http.Request, a subsonic.Auth) error {
	plain, err := json.Marshal(payload{Auth: a, Server: a.Server, Exp: time.Now().Add(m.ttl).Unix()})
	if err != nil {
		return err
	}
	nonce := make([]byte, m.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	sealed := m.aead.Seal(nonce, nonce, plain, nil)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    base64.RawURLEncoding.EncodeToString(sealed),
		Path:     "/",
		MaxAge:   int(m.ttl.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (m *Manager) Get(r *http.Request) (subsonic.Auth, error) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return subsonic.Auth{}, err
	}
	sealed, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(sealed) < m.aead.NonceSize() {
		return subsonic.Auth{}, errors.New("会话无效")
	}
	n := m.aead.NonceSize()
	plain, err := m.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return subsonic.Auth{}, errors.New("会话无效")
	}
	var p payload
	if err := json.Unmarshal(plain, &p); err != nil {
		return subsonic.Auth{}, err
	}
	if time.Now().Unix() > p.Exp {
		return subsonic.Auth{}, errors.New("会话已过期")
	}
	if p.Server == "" {
		return subsonic.Auth{}, errors.New("会话缺少服务器地址")
	}
	p.Auth.Server = p.Server
	return p.Auth, nil
}

func (m *Manager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
}
